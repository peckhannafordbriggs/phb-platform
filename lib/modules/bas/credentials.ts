import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * AES-256-GCM for the Niagara station passwords (B7.4).
 *
 * The key lives in BAS_CREDENTIAL_KEY and never in the database beside the
 * ciphertext. A database dump on its own decrypts to nothing, which is the only
 * property that makes storing these worth doing at all.
 *
 * NOTHING IN THIS FILE LOGS, and nothing it throws carries a plaintext, a
 * ciphertext or a key. `CredentialError` takes a fixed message chosen from a
 * closed set - see the class. That is enforced by a test that throws from the
 * middle of a save and greps the error for the password.
 *
 * GCM rather than CBC: it authenticates. A CBC ciphertext can be altered into a
 * different plaintext without the key, and a station password that silently
 * became a different station password would present as a login failure against
 * a live JACE, weeks later, with nothing pointing here.
 */

/** Read LAZILY, exactly like readGraphEnv. */
const ENV_VAR = "BAS_CREDENTIAL_KEY";

/** AES-256. Anything else is a configuration mistake, not a shorter key. */
const KEY_BYTES = 32;
/** 96 bits, the size GCM is defined for. Longer is re-hashed and weaker. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The envelope, as stored in `password_ciphertext`.
 *
 * `v1:<base64 iv>:<base64 tag>:<base64 ciphertext>`
 *
 * Delimited and prefixed rather than one opaque blob so that a person looking
 * at a row in psql can tell what they are looking at, and so a future format
 * can be introduced without guessing at the old one's length. `key_version` is
 * a separate COLUMN and does not appear here - which key encrypted a row and
 * how the bytes are arranged are different questions, and rotating one must not
 * require reparsing the other.
 */
const FORMAT = "v1";

export type CredentialFailure =
  /** BAS_CREDENTIAL_KEY is absent or blank. */
  | "key_missing"
  /** Present but not 32 bytes of base64, or not base64 at all. */
  | "key_invalid"
  /** The stored value is not a v1 envelope. */
  | "ciphertext_malformed"
  /**
   * The key does not match the ciphertext, or the ciphertext was altered.
   * Indistinguishable on purpose - GCM cannot tell you which, and a message
   * that guessed would be wrong half the time.
   */
  | "decrypt_failed";

/**
 * Carries a CODE, never a value.
 *
 * The message is derived from the code and nothing else. There is no
 * constructor that accepts arbitrary text, so no future caller can interpolate
 * a password into one by accident - which is a thing that happens, and the
 * reason this is a class rather than a plain Error with a nice message.
 */
export class CredentialError extends Error {
  constructor(readonly code: CredentialFailure) {
    super(MESSAGES[code]);
    this.name = "CredentialError";
  }
}

const MESSAGES: Record<CredentialFailure, string> = {
  key_missing:
    "Credential storage is not configured on this server. Set BAS_CREDENTIAL_KEY.",
  key_invalid:
    "BAS_CREDENTIAL_KEY is not a 32-byte base64 key. Credential storage is disabled.",
  ciphertext_malformed:
    "The stored credential is not in a format this build understands.",
  decrypt_failed:
    "The stored credential could not be decrypted with the current key.",
};

export type KeyState =
  | { available: true }
  | { available: false; reason: Extract<CredentialFailure, "key_missing" | "key_invalid"> };

/**
 * Whether credential management is usable, WITHOUT decrypting anything.
 *
 * Lazy, like readGraphEnv: a missing key disables this one feature and nothing
 * else. It must never stop the platform booting, and it must not stop the rest
 * of the Settings tab working either - projects, buildings and the tree are all
 * fine without it, and a screen that went blank because a password could not be
 * set would be a worse failure than the one it is reporting.
 */
export function credentialKeyState(): KeyState {
  const raw = process.env[ENV_VAR]?.trim();
  if (raw === undefined || raw.length === 0) {
    return { available: false, reason: "key_missing" };
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, "base64");
  } catch {
    return { available: false, reason: "key_invalid" };
  }

  // Buffer.from does not throw on non-base64; it returns whatever it could
  // decode. The length check is what actually rejects a bad value.
  if (decoded.length !== KEY_BYTES) {
    return { available: false, reason: "key_invalid" };
  }

  return { available: true };
}

function readKey(): Buffer {
  const state = credentialKeyState();
  if (!state.available) throw new CredentialError(state.reason);
  return Buffer.from(process.env[ENV_VAR]!.trim(), "base64");
}

/**
 * The key version stored alongside the ciphertext.
 *
 * One key today, so this is 1. It exists so a second key can be introduced
 * without a flag day: rows carry which key made them, and a rotation re-encrypts
 * at leisure rather than all at once. Sourced from BAS_CREDENTIAL_KEY_VERSION if
 * set, so the rotation does not need a deploy of this file.
 */
export function currentKeyVersion(): number {
  const raw = process.env.BAS_CREDENTIAL_KEY_VERSION?.trim();
  if (raw === undefined || !/^[0-9]{1,4}$/.test(raw)) return 1;
  return Number(raw);
}

export function encryptPassword(plaintext: string): string {
  const key = readKey();
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    FORMAT,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Only the collector and a deliberate rotation ever call this.
 *
 * No API route does, and a test walks every settings route asserting that no
 * response body contains a plaintext or a ciphertext. It is exported because
 * encryption nobody can reverse is not encryption, and because a round-trip
 * test is the only way to know the envelope is right.
 */
export function decryptPassword(envelope: string): string {
  const key = readKey();

  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT) {
    throw new CredentialError("ciphertext_malformed");
  }

  const iv = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");
  const ciphertext = Buffer.from(parts[3]!, "base64");

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CredentialError("ciphertext_malformed");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // The underlying error is swallowed deliberately. Node's message for a
    // failed GCM tag is harmless, but re-raising a caught error from a crypto
    // routine is how a buffer ends up in a stack trace somewhere downstream.
    throw new CredentialError("decrypt_failed");
  }
}

/**
 * Constant-time comparison, for a future rotation that has to check whether a
 * re-encrypted row still holds the same secret.
 *
 * Not used by any route today. Here because the obvious `a === b` on a
 * plaintext is the kind of thing that gets written in a hurry during a
 * rotation, and having the right tool present is cheaper than noticing later.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

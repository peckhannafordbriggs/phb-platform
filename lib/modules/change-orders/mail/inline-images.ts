import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Inline images: how a `cid:` reference in a body becomes something the
 * reading pane can load.
 *
 * The reading pane is a sandboxed iframe with no `allow-same-origin`, which
 * gives it an opaque origin. Every request it makes is cross-site to the
 * browser, and a `SameSite=Lax` session cookie - which is what Auth.js sets -
 * is not sent on a cross-site subresource request. Measured on 2026-11-12 in
 * Chrome and Edge: an <img> inside the sandboxed frame arrives with
 * `Sec-Fetch-Site: cross-site` and no cookie, while the same <img> in the top
 * document or in an unsandboxed frame carries it. So the image route cannot
 * see who is asking, and a route behind `withMailbox` would answer 401 to
 * every image.
 *
 * Giving the frame `allow-same-origin` would fix that and remove one of the
 * three layers between a vendor's markup and the platform's origin
 * (message-body.tsx). Inlining the bytes as `data:` URLs would keep the layers
 * and put every image into the message JSON - runbook.md says why not.
 *
 * So the grant-gated message route, having already established who is asking
 * and that they hold the module grant, writes a SIGNED LINK for each inline
 * image it resolves: this message, this attachment, an expiry, and an HMAC
 * over the three under a key derived from AUTH_SECRET. The image route checks
 * the signature and the expiry and nothing else. A link is a capability to
 * read one image of one message for an hour, minted only for a viewer who
 * passed the grant check, carried only inside the sandboxed document, which
 * sends no referrer. It is not a session and cannot be used for anything
 * else: the attachment id is part of what is signed.
 */

/**
 * An hour. Long enough that a message left open over lunch still shows its
 * images if the pane re-renders; short enough that a link copied out of the
 * document is not a lasting way to read the image.
 */
export const INLINE_IMAGE_LINK_TTL_SECONDS = 60 * 60;

/**
 * The message routes' path. The body document's CSP permits exactly this
 * prefix on the platform's own origin and nothing else of ours, so the only
 * same-origin request a body can cause is one the service wrote for it.
 */
export const MESSAGE_ROUTES_PATH = "/api/modules/change-orders/messages";

/**
 * A purpose-specific key rather than AUTH_SECRET itself: the session secret is
 * never used directly as a MAC key for anything else, and a leaked image link
 * says nothing about the session key.
 */
export function deriveInlineImageKey(authSecret: string): Buffer {
  return createHmac("sha256", authSecret)
    .update("phb-platform change-orders inline-image link v1")
    .digest();
}

export interface InlineImageLink {
  messageId: string;
  attachmentId: string;
  /** Unix seconds. */
  expiresAt: number;
}

function signatureOf(key: Buffer, link: InlineImageLink): string {
  // Newline-separated so no id can be read as part of its neighbour: the ids
  // are opaque Exchange strings that never contain a newline.
  return createHmac("sha256", key)
    .update(`${link.messageId}\n${link.attachmentId}\n${link.expiresAt}`)
    .digest("base64url");
}

/**
 * The URL the sanitizer writes into the body for one resolved inline image.
 * Relative, so it resolves against whichever address the platform is being
 * used at - both hostnames answer, and a srcdoc document resolves relative
 * URLs against its parent's.
 */
export function inlineImageUrl(
  key: Buffer,
  messageId: string,
  attachmentId: string,
  now: number = Date.now(),
): string {
  const link: InlineImageLink = {
    messageId,
    attachmentId,
    expiresAt: Math.floor(now / 1000) + INLINE_IMAGE_LINK_TTL_SECONDS,
  };

  return (
    `${MESSAGE_ROUTES_PATH}/${encodeURIComponent(messageId)}` +
    `/inline-images/${encodeURIComponent(attachmentId)}` +
    `?exp=${link.expiresAt}&sig=${signatureOf(key, link)}`
  );
}

export type InlineImageLinkVerdict = "valid" | "expired" | "invalid";

/** A base64url SHA-256: 32 bytes, 43 characters, no padding. */
const SIGNATURE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Checks a link's signature before its expiry, so a forged link is "invalid"
 * whatever expiry it claims. Constant-time on the signature, because the
 * comparison is the whole gate.
 */
export function verifyInlineImageLink(
  key: Buffer,
  candidate: {
    messageId: string;
    attachmentId: string;
    exp: string | null;
    sig: string | null;
  },
  now: number = Date.now(),
): InlineImageLinkVerdict {
  if (candidate.exp === null || candidate.sig === null) return "invalid";
  if (!/^\d{1,12}$/.test(candidate.exp)) return "invalid";
  if (!SIGNATURE_SHAPE.test(candidate.sig)) return "invalid";

  const expiresAt = Number.parseInt(candidate.exp, 10);
  const expected = Buffer.from(
    signatureOf(key, {
      messageId: candidate.messageId,
      attachmentId: candidate.attachmentId,
      expiresAt,
    }),
    "utf8",
  );
  const presented = Buffer.from(candidate.sig, "utf8");

  if (expected.length !== presented.length) return "invalid";
  if (!timingSafeEqual(expected, presented)) return "invalid";

  return expiresAt * 1000 < now ? "expired" : "valid";
}

/**
 * Graph stores a Content-ID without its angle brackets; a body may reference
 * it with them, with surrounding whitespace, or percent-encoded. Both sides
 * are reduced to the same form before they are compared.
 */
export function normaliseContentId(raw: string): string {
  let value = raw.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // Not percent-encoded, or not validly so. The literal text is the id.
  }
  value = value.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  return value.trim();
}

/** The Content-ID named by a `cid:` src, or null when the src is not one. */
export function contentIdReference(src: string): string | null {
  const trimmed = src.trim();
  if (!/^cid:/i.test(trimmed)) return null;
  const id = normaliseContentId(trimmed.slice("cid:".length));
  return id.length > 0 ? id : null;
}

export type RasterImageType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/bmp";

/**
 * What kind of image the bytes are, decided from the bytes and never from the
 * declared content type - a vendor chooses the declared type.
 *
 * Raster formats only. SVG is text with a script element in its grammar, and
 * the image route serves inline; an SVG served inline on the platform's origin
 * and then opened directly would run in that origin. Nothing here can name it.
 */
export function sniffImageType(bytes: Uint8Array): RasterImageType | null {
  if (bytes.length < 12) return null;

  const at = (i: number) => bytes[i];
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));

  if (at(0) === 0x89 && ascii(1, 4) === "PNG" && at(4) === 0x0d && at(5) === 0x0a) {
    return "image/png";
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 2) === "BM") return "image/bmp";

  return null;
}

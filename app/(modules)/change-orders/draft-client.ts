import type {
  DraftForEdit,
  MailAddress,
} from "@/lib/modules/change-orders/mail/types";
import { ApiError } from "./mailbox-client";

/**
 * The browser's view of the draft-editing API.
 *
 * Separate from mailbox-client.ts because these are the writes. Everything here
 * either changes a draft or sends one, and it is worth being able to see all of
 * that in one short file.
 */

export interface LockState {
  heldByYou: boolean;
  heldBy: { id: string; firstName: string; lastName: string } | null;
  expiresAt: string | null;
}

export interface DraftResult {
  draft: DraftForEdit;
  lock: LockState;
}

export interface SendResult {
  sent: true;
  subject: string | null;
  to: MailAddress[];
  cc: MailAddress[];
}

const BASE = "/api/modules/change-orders/drafts";

async function request<T>(
  path: string,
  init: RequestInit & { method: string },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, cache: "no-store" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("network", "Could not reach the server.");
  }

  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: { code?: string; message?: string } }
    | null;

  if (!response.ok || payload?.error !== undefined) {
    throw new ApiError(
      payload?.error?.code ?? "unexpected",
      payload?.error?.message ?? "Something went wrong.",
    );
  }

  if (payload?.data === undefined) {
    throw new ApiError("unexpected", "The server returned nothing.");
  }
  return payload.data;
}

const json = (body: unknown) => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * `images=1` only affects the sanitized preview in the response. Remote images
 * stay blocked by default, because loading one tells the sender the message was
 * opened, by whom and when.
 */
const withImages = (path: string, allowRemoteImages: boolean) =>
  allowRemoteImages ? `${path}?images=1` : path;

/** Opens the draft for editing and takes the advisory lock. */
export function openDraft(
  messageId: string,
  allowRemoteImages = false,
  signal?: AbortSignal,
): Promise<DraftResult> {
  return request(
    withImages(`${BASE}/${encodeURIComponent(messageId)}`, allowRemoteImages),
    { method: "GET", signal },
  );
}

export interface DraftPatch {
  subject?: string;
  to?: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  body?: { content: string; format: "html" | "text" };
  bodyEdits?: { id: string; text: string }[];
  appendNote?: string;
  expectedChangeKey: string | null;
}

export function saveDraft(
  messageId: string,
  patch: DraftPatch,
  allowRemoteImages = false,
  signal?: AbortSignal,
): Promise<DraftResult> {
  return request(
    withImages(`${BASE}/${encodeURIComponent(messageId)}`, allowRemoteImages),
    { method: "PATCH", signal, ...json(patch) },
  );
}

/**
 * Sends the draft. Carries only the version the sender reviewed - never
 * recipients, subject or content.
 */
export function sendDraft(
  messageId: string,
  expectedChangeKey: string | null,
): Promise<SendResult> {
  return request(`${BASE}/${encodeURIComponent(messageId)}/send`, {
    method: "POST",
    ...json({ expectedChangeKey }),
  });
}

export function releaseDraft(messageId: string): Promise<LockState> {
  return request(`${BASE}/${encodeURIComponent(messageId)}`, { method: "DELETE" });
}

/** Recipients as an editable string, and back. */
export function addressesToText(addresses: MailAddress[]): string {
  return addresses.map((a) => a.address).join(", ");
}

export function textToAddresses(text: string): {
  addresses: MailAddress[];
  invalid: string[];
} {
  const addresses: MailAddress[] = [];
  const invalid: string[] = [];

  for (const raw of text.split(/[,;]/)) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    // Deliberately permissive but not absent: a typo that Graph would reject
    // with a 400 mid-send is worth catching while the person is still looking at
    // the field.
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      addresses.push({ name: null, address: trimmed });
    } else {
      invalid.push(trimmed);
    }
  }

  return { addresses, invalid };
}

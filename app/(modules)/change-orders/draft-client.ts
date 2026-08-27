import type {
  AttachmentSummary,
  DerivedDraftMode,
  DraftForEdit,
  MailAddress,
  MoveResult,
} from "@/lib/modules/change-orders/mail/types";
import { ApiError } from "./mailbox-client";

/**
 * The browser's view of the draft-editing API.
 *
 * Separate from mailbox-client.ts because these are the writes. Everything here
 * either changes a draft or sends one, and it is worth being able to see all of
 * that in one short file.
 */

/**
 * How often an open editor renews the advisory lock.
 *
 * Half the server-side TTL, and that ratio is the point rather than the number:
 * one refresh may be lost - a dropped request, a sleeping laptop, a throttle -
 * and the lock still survives to the next one. It must also stay comfortably
 * BELOW the TTL, or an editor somebody is actively typing in would keep losing
 * its own lock and retaking it.
 *
 * The other half of "a lock never strands a draft" is the TTL itself: a closed
 * tab sends no release, so expiry is the release mechanism. See
 * lib/modules/change-orders/mail/draft-locks.ts.
 */
export const LOCK_REFRESH_MS = 45_000;

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

// ---------------------------------------------------------------- Phase 8

const MESSAGES = "/api/modules/change-orders/messages";

/**
 * Reply, reply-all or forward.
 *
 * Returns the created draft in the same shape `openDraft` returns, because it IS
 * the same thing: the caller hands it to the Phase 6 editor. Nothing about the
 * content is sent - Exchange writes the quoting, the threading and the recipient
 * list, and the person types into the editor afterwards.
 */
export function createDerivedDraft(
  messageId: string,
  mode: DerivedDraftMode,
): Promise<DraftResult> {
  return request(`${MESSAGES}/${encodeURIComponent(messageId)}/respond`, {
    method: "POST",
    ...json({ mode }),
  });
}

/** A draft from scratch. Opens in the same editor; there is no compose window. */
export function createDraft(
  input: { subject?: string } = {},
): Promise<DraftResult> {
  return request("/api/modules/change-orders/drafts", {
    method: "POST",
    ...json(input),
  });
}

/**
 * Files a message into a folder.
 *
 * `destinationFolderId` is the opaque id from the folder tree the workspace
 * already has. The browser never names a folder by path or display name.
 */
export function moveMessage(
  messageId: string,
  destinationFolderId: string,
): Promise<MoveResult> {
  return request(`${MESSAGES}/${encodeURIComponent(messageId)}/move`, {
    method: "POST",
    ...json({ destinationFolderId }),
  });
}

/** To Deleted Items, recoverably. There is no permanent delete to call. */
export function deleteMessage(
  messageId: string,
): Promise<{ deleted: true; subject: string | null }> {
  return request(`${MESSAGES}/${encodeURIComponent(messageId)}`, {
    method: "DELETE",
  });
}

/**
 * The URL a download link points at.
 *
 * A plain link rather than a fetch-and-blob: the browser's own download
 * handling gets the filename from Content-Disposition, shows progress, and never
 * holds the whole file in the page's memory. The route is same-origin, so the
 * session cookie goes with it.
 */
export function attachmentDownloadUrl(
  messageId: string,
  attachmentId: string,
): string {
  return `${MESSAGES}/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/**
 * Adds one attachment to a draft.
 *
 * One file per call, deliberately - the route takes one, so a person picking
 * three files makes three requests and sees three outcomes rather than one
 * ambiguous partial failure.
 *
 * No Content-Type header: the browser sets the multipart boundary itself, and
 * setting it by hand produces a body the server cannot parse.
 */
export function addAttachment(
  messageId: string,
  file: File,
): Promise<{ attachments: AttachmentSummary[] }> {
  const form = new FormData();
  form.set("file", file);

  return request(
    `${BASE}/${encodeURIComponent(messageId)}/attachments`,
    { method: "POST", body: form },
  );
}

export function removeAttachment(
  messageId: string,
  attachmentId: string,
): Promise<{ attachments: AttachmentSummary[] }> {
  return request(
    `${BASE}/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: "DELETE" },
  );
}

"use client";

import { useCallback, useRef, useState } from "react";
import type { AttachmentSummary } from "@/lib/modules/change-orders/mail/types";
import { MAX_ATTACHMENT_BYTES } from "@/lib/modules/change-orders/mail/attachments";
import { ApiError } from "./mailbox-client";
import {
  addAttachment,
  attachmentDownloadUrl,
  removeAttachment,
} from "./draft-client";

/**
 * Attachments, in the two places they appear.
 *
 * `AttachmentList` is the read-only one, in the reading pane. `DraftAttachments`
 * is the editable one, inside the Phase 6 editor - not a separate screen, because
 * an attachment belongs to the draft somebody is reviewing and a second surface
 * for it would be a second place to get the draft's state wrong.
 *
 * Downloads are plain links. The browser's own download handling gets the
 * filename from the Content-Disposition header the route sets, so nothing here
 * decides what a file is called - which is what keeps a vendor-supplied filename
 * out of the page entirely.
 */

export function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read-only. Every attachment is downloadable; none can be removed. */
export function AttachmentList({
  messageId,
  attachments,
}: {
  messageId: string;
  attachments: AttachmentSummary[];
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <p className="text-xs font-medium text-[var(--muted)]">
        {attachments.length === 1
          ? "1 attachment"
          : `${attachments.length} attachments`}
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-2">
        {attachments.map((a) => (
          <li key={a.id}>
            <AttachmentLink messageId={messageId} attachment={a} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function AttachmentLink({
  messageId,
  attachment,
}: {
  messageId: string;
  attachment: AttachmentSummary;
}) {
  return (
    <a
      href={attachmentDownloadUrl(messageId, attachment.id)}
      // The response is Content-Disposition: attachment, so this downloads
      // rather than navigating whatever the browser thinks of the type.
      download
      title={attachment.contentType ?? undefined}
      className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs hover:border-[var(--accent)]"
    >
      <span aria-hidden="true">📎</span>
      <span className="max-w-[18rem] truncate">
        {attachment.name ?? "(unnamed)"}
      </span>
      <span className="text-[var(--muted)]">{formatSize(attachment.sizeBytes)}</span>
    </a>
  );
}

/**
 * The editable list, for a draft.
 *
 * The reason the whole refreshed list comes back from the server after every add
 * and remove: a draft the automation created already carries attachments that
 * downstream flows expect, and the thing worth being sure of is not "my file
 * arrived" but "the others are still there". Showing the server's list rather
 * than a locally patched one is what makes that visible instead of assumed.
 */
export function DraftAttachments({
  messageId,
  attachments,
  disabled,
  onChanged,
}: {
  messageId: string;
  attachments: AttachmentSummary[];
  disabled: boolean;
  /** The editor re-reads the draft, so `hasAttachments` and the list agree. */
  onChanged: (attachments: AttachmentSummary[]) => void;
}) {
  const picker = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);

  const upload = useCallback(
    async (file: File) => {
      setError(null);

      // Answered here as well as by the server, so the person is told before
      // waiting for a 25 MB upload to be refused.
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(
          `“${file.name}” is ${formatSize(file.size)}. The limit is ${
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
          } MB.`,
        );
        return;
      }

      setBusy(true);
      try {
        const result = await addAttachment(messageId, file);
        onChanged(result.attachments);
      } catch (caught) {
        setError(
          caught instanceof ApiError
            ? caught.message
            : "That file could not be attached.",
        );
      } finally {
        setBusy(false);
      }
    },
    [messageId, onChanged],
  );

  const remove = useCallback(
    async (attachmentId: string) => {
      setError(null);
      setBusy(true);
      try {
        const result = await removeAttachment(messageId, attachmentId);
        onChanged(result.attachments);
        setConfirmingRemoval(null);
      } catch (caught) {
        setError(
          caught instanceof ApiError
            ? caught.message
            : "That attachment could not be removed.",
        );
      } finally {
        setBusy(false);
      }
    },
    [messageId, onChanged],
  );

  return (
    <div className="space-y-2">
      {attachments.length > 0 && (
        <ul className="space-y-1.5">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center gap-2">
              <AttachmentLink messageId={messageId} attachment={a} />

              {confirmingRemoval === a.id ? (
                <span className="flex items-center gap-1.5 text-xs">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(a.id)}
                    className="rounded bg-red-700 px-2 py-0.5 font-medium text-white disabled:opacity-50"
                  >
                    {busy ? "Removing…" : "Remove it"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmingRemoval(null)}
                    className="text-[var(--muted)] underline underline-offset-2"
                  >
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={disabled || busy}
                  onClick={() => setConfirmingRemoval(a.id)}
                  className="text-xs text-[var(--muted)] underline underline-offset-2 hover:text-red-700 disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={picker}
          type="file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so choosing the same file twice fires onChange again -
            // which is the retry path after a failed upload.
            event.target.value = "";
            if (file !== undefined) void upload(file);
          }}
        />
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => picker.current?.click()}
          className="rounded border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--surface)] disabled:opacity-50"
        >
          {busy ? "Working…" : "Attach a file"}
        </button>
        <span className="text-xs text-[var(--muted)]">
          One file at a time, up to {MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.
          Program and script files are not accepted.
        </span>
      </div>

      {error !== null && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

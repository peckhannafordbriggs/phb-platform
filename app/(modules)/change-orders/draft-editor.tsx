"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AttachmentSummary } from "@/lib/modules/change-orders/mail/types";
import { ApiError } from "./mailbox-client";
import {
  addressesToText,
  openDraft,
  releaseDraft,
  saveDraft,
  sendDraft,
  textToAddresses,
  type DraftResult,
  type LockState,
} from "./draft-client";
import { MailErrorState, PaneMessage, ReadingPaneSkeleton } from "./states";

/**
 * Review, edit and send one draft.
 *
 * The safety model, restated because this is where it is implemented:
 * one human, one draft, one deliberate action, having seen the content. There is
 * no multi-select, no send-all, no scheduled send, and the send control is
 * disabled from the moment it is clicked until the answer comes back.
 *
 * Every rule that matters is enforced in the service, not here. This component
 * makes the safe path obvious and the unsafe path unreachable by accident; it is
 * not what makes the unsafe path impossible.
 */

/** Long enough not to write on every keystroke, short enough to feel saved. */
const AUTOSAVE_DEBOUNCE_MS = 1_200;
/** The lock lapses at 90s, so refresh comfortably inside that. */
const LOCK_REFRESH_MS = 45_000;

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; at: number }
  | { status: "failed"; message: string };

interface Draft {
  subject: string;
  to: string;
  cc: string;
  bcc: string;
  body: string;
}

export function DraftEditor({
  messageId,
  attachments,
  onSent,
  onGone,
}: {
  messageId: string;
  attachments: AttachmentSummary[];
  onSent: (summary: { subject: string | null; recipients: string[] }) => void;
  onGone: () => void;
}) {
  const [loaded, setLoaded] = useState<DraftResult | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [fields, setFields] = useState<Draft | null>(null);
  const [bodyFormat, setBodyFormat] = useState<"html" | "text">("text");
  const [changeKey, setChangeKey] = useState<string | null>(null);
  const [lock, setLock] = useState<LockState | null>(null);

  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<ApiError | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<Draft | null>(null);
  latest.current = fields;

  // ------------------------------------------------------------------ open

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null);
    setLoadError(null);
    setFields(null);
    setSave({ status: "idle" });
    setDirty(false);
    setConfirming(false);
    setSendError(null);

    void (async () => {
      try {
        const result = await openDraft(messageId, controller.signal);
        setLoaded(result);
        setChangeKey(result.draft.changeKey);
        setLock(result.lock);
        setBodyFormat(result.draft.bodyFormat);
        setFields({
          subject: result.draft.subject ?? "",
          to: addressesToText(result.draft.to),
          cc: addressesToText(result.draft.cc),
          bcc: addressesToText(result.draft.bcc),
          body: result.draft.body,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (error instanceof ApiError) {
          if (error.code === "not_found") onGone();
          else setLoadError(error);
        }
      }
    })();

    return () => {
      controller.abort();
      // Best effort. If the tab is closing this never lands, which is exactly
      // why the lock also expires on its own.
      void releaseDraft(messageId).catch(() => undefined);
    };
  }, [messageId, onGone]);

  // -------------------------------------------------------------- autosave

  const persist = useCallback(
    async (next: Draft): Promise<boolean> => {
      const to = textToAddresses(next.to);
      const cc = textToAddresses(next.cc);
      const bcc = textToAddresses(next.bcc);

      if (to.invalid.length > 0 || cc.invalid.length > 0 || bcc.invalid.length > 0) {
        setSave({
          status: "failed",
          message: `Not an email address: ${[...to.invalid, ...cc.invalid, ...bcc.invalid].join(", ")}`,
        });
        return false;
      }

      setSave({ status: "saving" });
      try {
        const result = await saveDraft(messageId, {
          subject: next.subject,
          to: to.addresses,
          cc: cc.addresses,
          bcc: bcc.addresses,
          body: { content: next.body, format: bodyFormat },
          expectedChangeKey: changeKey,
        });

        setChangeKey(result.draft.changeKey);
        setLock(result.lock);
        setSave({ status: "saved", at: Date.now() });
        setDirty(false);
        return true;
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.code === "not_found") {
            onGone();
            return false;
          }
          // A silent failed save on a message someone is about to send is the
          // worst outcome in this phase, so this is loud and it blocks the send.
          setSave({ status: "failed", message: error.message });
        }
        return false;
      }
    },
    [messageId, bodyFormat, changeKey, onGone],
  );

  const scheduleSave = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const current = latest.current;
      if (current !== null) void persist(current);
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [persist]);

  const edit = useCallback(
    (patch: Partial<Draft>) => {
      setFields((current) => (current === null ? null : { ...current, ...patch }));
      setDirty(true);
      setSave({ status: "idle" });
      scheduleSave();
    },
    [scheduleSave],
  );

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  // ------------------------------------------------------------ lock refresh

  useEffect(() => {
    if (loaded === null) return;

    const interval = setInterval(() => {
      // Re-taking the lock is also how it is refreshed. A no-op save would cost
      // a Graph write; this costs one row update.
      void openDraft(messageId)
        .then((result) => setLock(result.lock))
        .catch(() => undefined);
    }, LOCK_REFRESH_MS);

    return () => clearInterval(interval);
  }, [loaded, messageId]);

  // ----------------------------------------------------------------- send

  const beginSend = useCallback(async () => {
    setSendError(null);

    // Flush any pending autosave and confirm it succeeded BEFORE showing the
    // confirmation. Sending a draft whose last edit did not persist sends
    // content nobody approved.
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }

    if (dirty || save.status === "failed") {
      const current = latest.current;
      if (current === null) return;
      const ok = await persist(current);
      if (!ok) return;
    }

    setConfirming(true);
  }, [dirty, save.status, persist]);

  const confirmSend = useCallback(async () => {
    if (sending) return;
    setSending(true);
    setSendError(null);

    try {
      const result = await sendDraft(messageId, changeKey);
      setConfirming(false);
      onSent({
        subject: result.subject,
        recipients: [...result.to, ...result.cc].map((a) => a.address),
      });
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "not_found") {
          setConfirming(false);
          onGone();
        } else {
          setSendError(error);
        }
      }
    } finally {
      setSending(false);
    }
  }, [sending, messageId, changeKey, onSent, onGone]);

  const recipientPreview = useMemo(() => {
    if (fields === null) return { addresses: [] as string[], invalid: [] as string[] };
    const to = textToAddresses(fields.to);
    const cc = textToAddresses(fields.cc);
    const bcc = textToAddresses(fields.bcc);
    return {
      addresses: [...to.addresses, ...cc.addresses, ...bcc.addresses].map((a) => a.address),
      invalid: [...to.invalid, ...cc.invalid, ...bcc.invalid],
    };
  }, [fields]);

  if (loadError !== null) {
    return <MailErrorState code={loadError.code} message={loadError.message} />;
  }
  if (loaded === null || fields === null) return <ReadingPaneSkeleton />;

  const lockedByOther = lock?.heldBy !== null && lock?.heldByYou === false;
  const canSend =
    !sending && !lockedByOther && save.status !== "failed" && recipientPreview.addresses.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b border-[var(--border)] px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
            Draft
          </span>
          <SaveIndicator state={save} dirty={dirty} />
        </div>

        {lockedByOther && (
          <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {lock?.heldBy?.firstName} {lock?.heldBy?.lastName} is editing this draft
            in the platform. Saving is blocked until they finish.
          </p>
        )}

        {/* Honest about what the lock does not cover. */}
        <p className="text-xs text-[var(--muted)]">
          Outlook can edit this draft at the same time, and the last save wins.
        </p>

        <Field label="To">
          <input
            value={fields.to}
            onChange={(e) => edit({ to: e.target.value })}
            disabled={lockedByOther}
            className="w-full rounded border border-[var(--border)] px-2 py-1 text-sm disabled:bg-[var(--surface)]"
          />
        </Field>
        <Field label="Cc">
          <input
            value={fields.cc}
            onChange={(e) => edit({ cc: e.target.value })}
            disabled={lockedByOther}
            className="w-full rounded border border-[var(--border)] px-2 py-1 text-sm disabled:bg-[var(--surface)]"
          />
        </Field>
        <Field label="Bcc">
          <input
            value={fields.bcc}
            onChange={(e) => edit({ bcc: e.target.value })}
            disabled={lockedByOther}
            className="w-full rounded border border-[var(--border)] px-2 py-1 text-sm disabled:bg-[var(--surface)]"
          />
        </Field>
        <Field label="Subject">
          <input
            value={fields.subject}
            onChange={(e) => edit({ subject: e.target.value })}
            disabled={lockedByOther}
            className="w-full rounded border border-[var(--border)] px-2 py-1 text-sm disabled:bg-[var(--surface)]"
          />
        </Field>

        {/* The tag is part of the subject and downstream filing depends on the
            exact string, so it is shown rather than parsed out and managed. */}
        <p className="text-xs text-[var(--muted)]">
          The subject is saved exactly as written, including any{" "}
          <code className="rounded bg-[var(--surface)] px-1">[CO tag]</code>.
        </p>

        {attachments.length > 0 && (
          <p className="text-xs text-[var(--muted)]">
            {attachments.length === 1
              ? "1 attachment is kept"
              : `${attachments.length} attachments are kept`}
            : {attachments.map((a) => a.name ?? "(unnamed)").join(", ")}. Editing does
            not change them.
          </p>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-6 py-3">
        <label className="mb-1 text-xs font-medium text-[var(--muted)]">
          Body ({bodyFormat === "html" ? "HTML" : "plain text"})
        </label>
        {/* A textarea, so the raw body is never parsed as markup. It is the
            original stored content, not the sanitized copy - saving the
            sanitized version back would overwrite the automation's formatting
            with a lossy one on every edit. */}
        <textarea
          value={fields.body}
          onChange={(e) => edit({ body: e.target.value })}
          disabled={lockedByOther}
          spellCheck
          className="min-h-0 w-full flex-1 resize-none rounded border border-[var(--border)] p-3 font-mono text-xs leading-relaxed disabled:bg-[var(--surface)]"
        />
      </div>

      <div className="shrink-0 border-t border-[var(--border)] px-6 py-3">
        {sendError !== null && (
          <p role="alert" className="mb-2 text-sm text-red-700">
            {sendError.message}
          </p>
        )}
        {save.status === "failed" && (
          <p role="alert" className="mb-2 text-sm text-red-700">
            The last change did not save, so this cannot be sent yet. {save.message}
          </p>
        )}

        <button
          type="button"
          disabled={!canSend}
          onClick={() => void beginSend()}
          className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Review and send…
        </button>
        <span className="ml-3 text-xs text-[var(--muted)]">
          You will see the recipients before anything is sent.
        </span>
      </div>

      {confirming && (
        <SendConfirmation
          subject={fields.subject}
          recipients={recipientPreview.addresses}
          sending={sending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void confirmSend()}
        />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-xs text-[var(--muted)]">{label}</span>
      {children}
    </label>
  );
}

function SaveIndicator({ state, dirty }: { state: SaveState; dirty: boolean }) {
  if (state.status === "saving") {
    return <span className="text-xs text-[var(--muted)]">Saving…</span>;
  }
  if (state.status === "failed") {
    return <span className="text-xs font-medium text-red-700">Not saved</span>;
  }
  if (state.status === "saved" && !dirty) {
    return <span className="text-xs text-green-700">Saved</span>;
  }
  if (dirty) {
    return <span className="text-xs text-[var(--muted)]">Unsaved changes</span>;
  }
  return null;
}

/**
 * The confirmation step.
 *
 * PHASE-6: "Not a generic 'are you sure' - show who this is about to go to."
 * Every address is listed, because the whole risk being guarded against is a
 * message reaching someone the sender did not intend.
 */
function SendConfirmation({
  subject,
  recipients,
  sending,
  onCancel,
  onConfirm,
}: {
  subject: string;
  recipients: string[];
  sending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Confirm send"
        className="w-full max-w-md rounded border border-[var(--border)] bg-white p-5 shadow-lg"
      >
        <h3 className="text-sm font-semibold">Send this message?</h3>

        <p className="mt-3 text-xs font-medium text-[var(--muted)]">Subject</p>
        <p className="text-sm">{subject || "(no subject)"}</p>

        <p className="mt-3 text-xs font-medium text-[var(--muted)]">
          {recipients.length === 1
            ? "It will go to 1 recipient"
            : `It will go to ${recipients.length} recipients`}
        </p>
        <ul className="mt-1 max-h-40 overflow-y-auto rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm">
          {recipients.map((address) => (
            <li key={address} className="truncate">
              {address}
            </li>
          ))}
        </ul>

        <p className="mt-3 text-xs text-[var(--muted)]">
          This cannot be undone. The message is sent from
          changeorder@phb1899.com and appears in its Sent Items.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={sending}
            className="rounded border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Cancel
          </button>
          {/* Disabled the instant it is clicked. A double send is not
              recoverable. */}
          <button
            type="button"
            onClick={onConfirm}
            disabled={sending}
            className="rounded bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send now"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SentConfirmation({
  summary,
  onDismiss,
}: {
  summary: { subject: string | null; recipients: string[] };
  onDismiss: () => void;
}) {
  return (
    <PaneMessage
      title="Sent"
      detail={`“${summary.subject ?? "(no subject)"}” went to ${summary.recipients.join(", ")}. It is now in changeorder@phb1899.com Sent Items.`}
      action={
        <button
          type="button"
          onClick={onDismiss}
          className="rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface)]"
        >
          Back to the list
        </button>
      }
    />
  );
}

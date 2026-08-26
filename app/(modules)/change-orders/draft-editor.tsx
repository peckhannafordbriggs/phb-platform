"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AttachmentSummary } from "@/lib/modules/change-orders/mail/types";
import { ApiError, describeUnexpected } from "./mailbox-client";
import { BodyEditor, BodySourceEditor } from "./body-editor";
import { DraftAttachments } from "./attachments";
import {
  addressesToText,
  openDraft,
  releaseDraft,
  saveDraft,
  sendDraft,
  textToAddresses,
  type DraftPatch,
  type DraftResult,
  type LockState,
} from "./draft-client";
import { MailErrorState, PaneMessage, ReadingPaneSkeleton } from "./states";

/**
 * Review, edit and send one draft.
 *
 * The safety model, restated because this is where it is implemented: one human,
 * one draft, one deliberate action, having seen the content. No multi-select, no
 * send-all, no scheduled send, and the send control is disabled from the moment
 * it is clicked until the answer comes back.
 *
 * Every rule that matters is enforced in the service, not here. This makes the
 * safe path obvious; it is not what makes the unsafe path impossible.
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

/** What the editor holds. Compared against `saved` to decide what to send. */
interface EditorState {
  subject: string;
  to: string;
  cc: string;
  bcc: string;
  /** segment id -> replacement text. Only genuinely changed runs. */
  bodyEdits: Record<string, string>;
  note: string;
  /** Only set in source mode. */
  source: string | null;
}

export function DraftEditor({
  messageId,
  attachments,
  remoteImagesAllowed,
  onShowImages,
  onAttachmentsChanged,
  onClose,
  onSent,
  onGone,
}: {
  messageId: string;
  attachments: AttachmentSummary[];
  remoteImagesAllowed: boolean;
  onShowImages: () => void;
  /**
   * An attachment was added or removed. The workspace re-reads the message so
   * the reading pane and the editor agree, rather than the editor keeping its
   * own copy of the list.
   */
  onAttachmentsChanged: () => void;
  /**
   * Leaves the editor for the read view of the same message.
   *
   * Needed once Phase 8 could open the editor directly - a reply or a forward
   * lands here without passing through the read view, so without this there was
   * no way to reach Move or Delete for a draft somebody decided not to send.
   */
  onClose: () => void;
  onSent: (summary: { subject: string | null; recipients: string[] }) => void;
  onGone: () => void;
}) {
  const [loaded, setLoaded] = useState<DraftResult | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [state, setState] = useState<EditorState | null>(null);
  const [saved, setSaved] = useState<EditorState | null>(null);
  const [changeKey, setChangeKey] = useState<string | null>(null);
  const [lock, setLock] = useState<LockState | null>(null);
  const [sourceMode, setSourceMode] = useState(false);

  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<ApiError | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<EditorState | null>(null);
  latest.current = state;

  const draft = loaded?.draft ?? null;

  // ------------------------------------------------------------------ open

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null);
    setLoadError(null);
    setState(null);
    setSaved(null);
    setSourceMode(false);
    setSave({ status: "idle" });
    setConfirming(false);
    setSendError(null);

    void (async () => {
      try {
        const result = await openDraft(
          messageId,
          remoteImagesAllowed,
          controller.signal,
        );
        const initial: EditorState = {
          subject: result.draft.subject ?? "",
          to: addressesToText(result.draft.to),
          cc: addressesToText(result.draft.cc),
          bcc: addressesToText(result.draft.bcc),
          bodyEdits: {},
          note: "",
          source: null,
        };

        setLoaded(result);
        setChangeKey(result.draft.changeKey);
        setLock(result.lock);
        setState(initial);
        setSaved(initial);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (error instanceof ApiError) {
          if (error.code === "not_found") onGone();
          else setLoadError(error);
        } else {
          setLoadError(
            new ApiError("unexpected", describeUnexpected(error, "opening a draft")),
          );
        }
      }
    })();

    return () => {
      controller.abort();
      // Best effort. A closing tab never lands this, which is why the lock also
      // expires on its own.
      void releaseDraft(messageId).catch(() => undefined);
    };
    // Re-opens when "show images" is switched on: the preview is sanitized on
    // the server, so images can only appear by re-reading it. The control
    // flushes any pending save first - see showImages below.
  }, [messageId, remoteImagesAllowed, onGone]);

  // -------------------------------------------------------------- autosave

  /**
   * Builds the patch from what actually changed.
   *
   * Previously every autosave sent every field, so editing the subject rewrote
   * the body too. A review that never touches the body must never rewrite it -
   * that is the difference between "preserved because nothing wrote it" and
   * "preserved because the write happened to round-trip".
   */
  const buildPatch = useCallback(
    (
      next: EditorState,
      base: EditorState,
      /**
       * Whether to include the appended paragraph.
       *
       * False for autosave, and that is the whole point - see commitNote. An
       * append is not idempotent: autosaving it turned one sentence typed with
       * two pauses into three separate paragraphs, because every debounce
       * committed what had been typed so far and then cleared the field.
       * Measured against the live mailbox: "Hello Joel," / " thanks for the
       * pricing" / " on RFI 229." arrived as three <p> elements.
       *
       * True only when a person deliberately commits the paragraph, or as part
       * of the flush immediately before a send - both of which are single
       * actions, so they append once.
       */
      includeNote: boolean,
    ): DraftPatch | null => {
      const patch: DraftPatch = { expectedChangeKey: changeKey };
      let changed = false;

      if (next.subject !== base.subject) {
        patch.subject = next.subject;
        changed = true;
      }

      for (const field of ["to", "cc", "bcc"] as const) {
        if (next[field] === base[field]) continue;
        const parsed = textToAddresses(next[field]);
        if (parsed.invalid.length > 0) {
          throw new ApiError(
            "validation_failed",
            `Not an email address: ${parsed.invalid.join(", ")}`,
          );
        }
        patch[field] = parsed.addresses;
        changed = true;
      }

      if (next.source !== null && next.source !== base.source) {
        patch.body = {
          content: next.source,
          format: draft?.bodyFormat ?? "html",
        };
        changed = true;
      } else {
        // Only runs whose text actually differs from the stored original.
        const edits = Object.entries(next.bodyEdits)
          .filter(([id, text]) => {
            const segment = draft?.segments.find((s) => s.id === id);
            return segment !== undefined && segment.text !== text;
          })
          .map(([id, text]) => ({ id, text }));

        if (edits.length > 0) {
          patch.bodyEdits = edits;
          changed = true;
        }

        if (includeNote && next.note.trim().length > 0) {
          patch.appendNote = next.note;
          changed = true;
        }
      }

      return changed ? patch : null;
    },
    [changeKey, draft],
  );

  const persist = useCallback(
    async (next: EditorState, includeNote = false): Promise<boolean> => {
      const base = saved;
      if (base === null) return false;

      let patch: DraftPatch | null;
      try {
        patch = buildPatch(next, base, includeNote);
      } catch (error) {
        if (error instanceof ApiError) {
          setSave({ status: "failed", message: error.message });
        }
        return false;
      }

      if (patch === null) {
        setSave({ status: "saved", at: Date.now() });
        return true;
      }

      setSave({ status: "saving" });
      try {
        const result = await saveDraft(messageId, patch, remoteImagesAllowed);

        setLoaded(result);
        setChangeKey(result.draft.changeKey);
        setLock(result.lock);

        /**
         * Rebase onto what Exchange now holds - without throwing away anything
         * typed while the request was in flight.
         *
         * The previous version adopted the server's value for every field
         * unconditionally, so a keystroke that landed during a save was
         * silently reverted. `keep` compares what is on screen NOW against what
         * was actually sent: if they differ the person has typed since, and
         * their text wins.
         *
         * Segment ids are recomputed from the new body, so `bodyEdits` is still
         * reset - a stale id would splice into the wrong place, which is worse
         * than losing an in-flight character.
         */
        const onScreen = latest.current;
        const keep = (field: "subject" | "to" | "cc" | "bcc"): string => {
          const typed = onScreen?.[field];
          if (typed !== undefined && typed !== next[field]) return typed;

          return field === "subject"
            ? (result.draft.subject ?? "")
            : addressesToText(result.draft[field]);
        };

        const rebased: EditorState = {
          subject: keep("subject"),
          to: keep("to"),
          cc: keep("cc"),
          bcc: keep("bcc"),
          bodyEdits: {},
          /**
           * Cleared only by the save that actually committed it. An autosave
           * must never empty the box somebody is still typing in - that is what
           * made a half-typed sentence appear to jump into another field.
           */
          note:
            onScreen !== null && onScreen.note !== next.note
              ? onScreen.note
              : patch.appendNote !== undefined
                ? ""
                : next.note,
          source: next.source === null ? null : result.draft.body,
        };
        setState(rebased);
        setSaved(rebased);
        setSave({ status: "saved", at: Date.now() });
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
        } else {
          // Same reasoning, and more so: an unexpected error here must not leave
          // the indicator reading "Saved" over content that was never written.
          setSave({
            status: "failed",
            message: describeUnexpected(error, "saving a draft"),
          });
        }
        return false;
      }
    },
    [saved, buildPatch, messageId, remoteImagesAllowed, onGone],
  );

  const scheduleSave = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const current = latest.current;
      if (current !== null) void persist(current);
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [persist]);

  const edit = useCallback(
    (patch: Partial<EditorState>) => {
      setState((current) => (current === null ? null : { ...current, ...patch }));
      setSave({ status: "idle" });
      scheduleSave();
    },
    [scheduleSave],
  );

  const editSegment = useCallback(
    (id: string, text: string) => {
      setState((current) =>
        current === null
          ? null
          : { ...current, bodyEdits: { ...current.bodyEdits, [id]: text } },
      );
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
      void openDraft(messageId, remoteImagesAllowed)
        .then((result) => setLock(result.lock))
        .catch(() => undefined);
    }, LOCK_REFRESH_MS);

    return () => clearInterval(interval);
  }, [loaded, messageId, remoteImagesAllowed]);

  // ----------------------------------------------------------------- send

  /**
   * Whether an autosave has anything to write. Excludes the pending paragraph,
   * which is committed deliberately rather than saved on a timer - `noteReady`
   * below is what tracks that.
   */
  const dirty = useMemo(() => {
    if (state === null || saved === null || draft === null) return false;
    try {
      return buildPatch(state, saved, false) !== null;
    } catch {
      return true;
    }
  }, [state, saved, draft, buildPatch]);

  /** A paragraph has been typed and not yet added to the message. */
  const noteReady = state !== null && state.note.trim().length > 0;

  /**
   * Adds the typed paragraph to the message, once.
   *
   * This is the deliberate action that replaced autosaving the append. It
   * flushes any pending autosave first so the paragraph is appended to the body
   * the person is actually looking at, not to a version missing their last
   * subject edit.
   */
  const commitNote = useCallback(async () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }

    const current = latest.current;
    if (current === null || current.note.trim().length === 0) return;

    await persist(current, true);
  }, [persist]);

  /**
   * Turning on remote images re-opens the draft, because the preview is
   * sanitized on the server. Re-opening rebases the editor onto what Exchange
   * holds, so anything still sitting in the autosave debounce has to be written
   * first or it would vanish when the pane came back.
   */
  const showImages = useCallback(async () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }

    const current = latest.current;
    if (dirty && current !== null) {
      // Not the note: turning images on is not a decision to add a paragraph.
      // It survives the re-open because the editor keeps it in state.
      const saved = await persist(current);
      if (!saved) return;
    }

    onShowImages();
  }, [dirty, persist, onShowImages]);

  const beginSend = useCallback(async () => {
    setSendError(null);

    // Flush any pending autosave and confirm it succeeded BEFORE showing the
    // confirmation. Sending a draft whose last edit did not persist sends
    // content nobody approved.
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }

    /**
     * Any pending paragraph goes in here too.
     *
     * Clicking send is one deliberate action, so appending once is right - and
     * dropping a paragraph somebody had typed but not yet added would be worse
     * than either alternative: they would send a message missing a sentence they
     * had written and could still see on screen.
     */
    if (dirty || noteReady || save.status === "failed") {
      const current = latest.current;
      if (current === null) return;
      const ok = await persist(current, true);
      if (!ok) return;
    }

    setConfirming(true);
  }, [dirty, noteReady, save.status, persist]);

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
      } else {
        // The one place silence would be worst: the sender is looking at a
        // confirmation dialog and needs to know whether the message went.
        setSendError(
          new ApiError("unexpected", describeUnexpected(error, "sending a draft")),
        );
      }
    } finally {
      setSending(false);
    }
  }, [sending, messageId, changeKey, onSent, onGone]);

  const recipients = useMemo(() => {
    if (state === null) return { addresses: [] as string[], invalid: [] as string[] };
    const to = textToAddresses(state.to);
    const cc = textToAddresses(state.cc);
    const bcc = textToAddresses(state.bcc);
    return {
      addresses: [...to.addresses, ...cc.addresses, ...bcc.addresses].map((a) => a.address),
      invalid: [...to.invalid, ...cc.invalid, ...bcc.invalid],
    };
  }, [state]);

  if (loadError !== null) {
    return <MailErrorState code={loadError.code} message={loadError.message} />;
  }
  if (draft === null || state === null) return <ReadingPaneSkeleton />;

  const lockedByOther = lock?.heldBy != null && lock.heldByYou === false;
  const canSend =
    !sending &&
    !lockedByOther &&
    save.status !== "failed" &&
    recipients.invalid.length === 0 &&
    recipients.addresses.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b border-[var(--border)] px-6 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
            Draft
          </span>
          <SaveIndicator state={save} dirty={dirty} />
          {/*
            Not a cancel: everything typed here has already been autosaved to
            Exchange, and closing the editor does not undo any of it. It goes to
            the read view of the same draft, which is where Move and Delete are.
          */}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--surface)]"
          >
            Close editor
          </button>
        </div>

        {lockedByOther && (
          <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {lock?.heldBy?.firstName} {lock?.heldBy?.lastName} is editing this draft
            in the platform. Saving is blocked until they finish.
          </p>
        )}

        <Field label="To">
          <input
            value={state.to}
            onChange={(e) => edit({ to: e.target.value })}
            disabled={lockedByOther}
            className="w-full rounded border border-[var(--border)] px-2 py-1 text-sm disabled:bg-[var(--surface)]"
          />
        </Field>
        <Field label="Cc">
          <input
            value={state.cc}
            onChange={(e) => edit({ cc: e.target.value })}
            disabled={lockedByOther}
            className="w-full rounded border border-[var(--border)] px-2 py-1 text-sm disabled:bg-[var(--surface)]"
          />
        </Field>
        <Field label="Bcc">
          <input
            value={state.bcc}
            onChange={(e) => edit({ bcc: e.target.value })}
            disabled={lockedByOther}
            className="w-full rounded border border-[var(--border)] px-2 py-1 text-sm disabled:bg-[var(--surface)]"
          />
        </Field>
        <Field label="Subject">
          <input
            value={state.subject}
            onChange={(e) => edit({ subject: e.target.value })}
            disabled={lockedByOther}
            className="w-full rounded border border-[var(--border)] px-2 py-1 text-sm disabled:bg-[var(--surface)]"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs text-[var(--muted)]">
            The subject is saved exactly as written, including any{" "}
            <code className="rounded bg-[var(--surface)] px-1">[CO tag]</code>.
          </p>
          <button
            type="button"
            onClick={() =>
              setSourceMode((on) => {
                if (!on) edit({ source: draft.body });
                else edit({ source: null });
                return !on;
              })
            }
            className="ml-auto text-xs text-[var(--accent)] underline underline-offset-2"
          >
            {sourceMode ? "Back to text view" : "Edit HTML source"}
          </button>
        </div>

        {/*
          Attachments live in the editor rather than on a screen of their own.
          A draft the automation created already carries attachments downstream
          flows expect, so the person changing them is the person reading the
          message - and every add and remove re-reads the list from Exchange, so
          "the others survived" is shown rather than assumed.
        */}
        <div className="border-t border-[var(--border)] pt-2">
          <DraftAttachments
            messageId={messageId}
            attachments={attachments}
            disabled={lockedByOther}
            onChanged={onAttachmentsChanged}
          />
        </div>
      </div>

      {sourceMode ? (
        <BodySourceEditor
          value={state.source ?? draft.body}
          disabled={lockedByOther}
          onChange={(next) => edit({ source: next })}
        />
      ) : (
        <BodyEditor
          preview={draft.preview}
          previewStale={dirty || save.status === "saving"}
          segments={draft.segments}
          edits={state.bodyEdits}
          note={state.note}
          disabled={lockedByOther}
          onEditSegment={editSegment}
          onNoteChange={(text) => edit({ note: text })}
          onCommitNote={() => void commitNote()}
          noteBusy={save.status === "saving"}
          onShowImages={showImages}
          remoteImagesAllowed={remoteImagesAllowed}
        />
      )}

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
          subject={state.subject}
          recipients={recipients.addresses}
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
  if (dirty) {
    return <span className="text-xs text-[var(--muted)]">Unsaved changes</span>;
  }
  if (state.status === "saved") {
    return <span className="text-xs text-green-700">Saved</span>;
  }
  return null;
}

/**
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
          This cannot be undone. The message is sent from changeorder@phb1899.com
          and appears in its Sent Items.
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
          {/* Disabled the instant it is clicked. A double send is not recoverable. */}
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

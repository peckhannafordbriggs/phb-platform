"use client";

import { useMemo, useState } from "react";
import type { DerivedDraftMode } from "@/lib/modules/change-orders/mail/types";
import { FolderTree } from "./folder-tree";
import { buildFolderTree, type FolderNode, type FolderTreeNode } from "./mailbox-client";

/**
 * What can be done to the message in the reading pane.
 *
 * Every action here is either reversible or produces a draft nobody has sent. A
 * move reverses, a delete goes to Deleted Items, and reply, reply-all and
 * forward create an unsent draft that opens in the Phase 6 editor. Sending stays
 * where it was: behind the editor's own confirmation, one message at a time.
 *
 * There is deliberately no multi-select and no bar that operates on a list. The
 * actions belong to the message somebody is looking at - CLAUDE.md prohibition 1
 * is about send specifically, but a "delete all these" affordance on a mailbox a
 * daily process runs through is the same shape of mistake.
 */

const RESPOND_LABELS: { mode: DerivedDraftMode; label: string; title: string }[] = [
  {
    mode: "reply",
    label: "Reply",
    title: "Create a reply draft, with the original quoted by Exchange",
  },
  {
    mode: "replyAll",
    label: "Reply all",
    title: "Create a reply to everyone on the original",
  },
  {
    mode: "forward",
    label: "Forward",
    title: "Create a forward draft, carrying the original attachments",
  },
];

export function MessageActions({
  busy,
  canRespond,
  onRespond,
  onMove,
  onDelete,
}: {
  /** An action is in flight. Every control is disabled until it settles. */
  busy: boolean;
  /**
   * False for a draft. Replying to something nobody has sent yet is not a
   * meaningful thing to do, and Graph refuses it.
   */
  canRespond: boolean;
  onRespond: (mode: DerivedDraftMode) => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canRespond &&
        RESPOND_LABELS.map(({ mode, label, title }) => (
          <button
            key={mode}
            type="button"
            disabled={busy}
            onClick={() => onRespond(mode)}
            title={title}
            className="rounded border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--surface)] disabled:opacity-50"
          >
            {label}
          </button>
        ))}

      <button
        type="button"
        disabled={busy}
        onClick={onMove}
        title="File this message into another folder"
        className="rounded border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--surface)] disabled:opacity-50"
      >
        Move…
      </button>

      <button
        type="button"
        disabled={busy}
        onClick={onDelete}
        title="Move this message to Deleted Items"
        className="rounded border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--phb-maroon)] hover:bg-[var(--neutral-100)] disabled:opacity-50"
      >
        Delete…
      </button>
    </div>
  );
}

/**
 * Where to file a message.
 *
 * The same tree the folder pane renders, from the same data, expanded to show
 * the Projects hierarchy - because filing into a project subfolder is the
 * realistic case. That is where the automation files things, and a picker that
 * only offered top-level folders would be a picker nobody could use for the job.
 *
 * The folder the message is already in is shown but not selectable: moving a
 * message to where it already is would be a write that changes nothing, and
 * offering it invites a confused second click.
 */
export function FolderPicker({
  folders,
  currentFolderId,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  folders: FolderNode[];
  currentFolderId: string | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (folder: FolderTreeNode) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Open every folder that has children. In the picker this is right where it
    // would be wrong in the sidebar: the whole point is to see the destinations,
    // and a collapsed Inbox hides the entire Projects tree.
    const withChildren = folders
      .filter((folder) => folder.childFolderCount > 0)
      .map((folder) => folder.id);
    return new Set(withChildren);
  });
  const [selected, setSelected] = useState<FolderTreeNode | null>(null);

  const tree = useMemo(() => buildFolderTree(folders), [folders]);

  const alreadyThere = selected !== null && selected.id === currentFolderId;

  return (
    <Dialog label="Move this message" onCancel={busy ? undefined : onCancel}>
      <h3 className="text-sm font-semibold">Move this message</h3>
      <p className="mt-1 text-xs text-[var(--muted)]">
        Choose a folder. The message moves in Exchange, so it moves in Outlook
        too.
      </p>

      <div className="mt-3 max-h-72 overflow-y-auto rounded border border-[var(--border)] bg-[var(--surface)]">
        <FolderTree
          nodes={tree}
          selectedId={selected?.id ?? null}
          expandedIds={expanded}
          onSelect={setSelected}
          onToggle={(id) =>
            setExpanded((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
        />
      </div>

      {alreadyThere && (
        <p className="mt-2 text-xs text-[var(--muted)]">
          That is the folder it is already in.
        </p>
      )}

      {error !== null && (
        <p role="alert" className="mt-2 text-xs text-[var(--phb-maroon)]">
          {error}
        </p>
      )}

      <DialogButtons
        busy={busy}
        onCancel={onCancel}
        confirmLabel={busy ? "Moving…" : "Move it"}
        confirmDisabled={selected === null || alreadyThere}
        onConfirm={() => selected !== null && onConfirm(selected)}
      />
    </Dialog>
  );
}

/**
 * The delete confirmation.
 *
 * It says where the message goes, in plain words, because implying permanence
 * would be both wrong and harmful: `DELETE` in Graph is a soft delete, and a
 * person who believes otherwise avoids an operation that is safe - or worse,
 * goes looking for a permanent one. There is not one, and there is not going to
 * be.
 */
export function DeleteConfirmation({
  subject,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  subject: string | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog label="Confirm delete" onCancel={busy ? undefined : onCancel}>
      <h3 className="text-sm font-semibold">Delete this message?</h3>

      <p className="mt-3 text-xs font-medium text-[var(--muted)]">Subject</p>
      <p className="text-sm">{subject ?? "(no subject)"}</p>

      <p className="mt-3 text-sm text-[var(--muted)]">
        It moves to <strong>Deleted Items</strong> in
        changeorder@phb1899.com, where it stays until Exchange&rsquo;s retention
        removes it. You or anyone with the mailbox open in Outlook can drag it
        back.
      </p>

      {error !== null && (
        <p role="alert" className="mt-2 text-xs text-[var(--phb-maroon)]">
          {error}
        </p>
      )}

      <DialogButtons
        busy={busy}
        onCancel={onCancel}
        confirmLabel={busy ? "Deleting…" : "Move to Deleted Items"}
        confirmTone="danger"
        onConfirm={onConfirm}
      />
    </Dialog>
  );
}

/**
 * Starting a message from scratch: one field, then the Phase 6 editor.
 *
 * A subject prompt rather than dropping straight into an empty draft, for two
 * reasons that happen to point the same way. The subject is load-bearing in this
 * mailbox - the bracketed project tag is what downstream filing reads - so
 * asking for it first is asking for the thing that matters. And outside
 * production the ZZTEST fence applies to the subject of the draft being created,
 * so this is where a test message gets named.
 *
 * It is not a compose window: there is no body here, no recipients and no send
 * button. It creates the draft and hands it to the editor every other draft
 * goes through.
 */
export function ComposePrompt({
  busy,
  error,
  onCancel,
  onCreate,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onCreate: (subject: string) => void;
}) {
  const [subject, setSubject] = useState("");

  return (
    <Dialog label="New message" onCancel={busy ? undefined : onCancel}>
      <h3 className="text-sm font-semibold">Start a new message</h3>
      <p className="mt-1 text-xs text-[var(--muted)]">
        This creates an unsent draft in changeorder@phb1899.com and opens it for
        editing. Recipients and the message itself go in next.
      </p>

      <label className="mt-3 block">
        <span className="mb-1 block text-xs text-[var(--muted)]">Subject</span>
        <input
          value={subject}
          autoFocus
          disabled={busy}
          onChange={(event) => setSubject(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) onCreate(subject);
          }}
          className="w-full rounded border border-[var(--border)] px-2 py-1.5 text-sm disabled:bg-[var(--surface)]"
        />
      </label>
      <p className="mt-1 text-xs text-[var(--muted)]">
        Saved exactly as written. If this message belongs to a project, include
        its bracketed tag &mdash; that is what the filing automation reads.
      </p>

      {error !== null && (
        <p role="alert" className="mt-2 text-xs text-[var(--phb-maroon)]">
          {error}
        </p>
      )}

      <DialogButtons
        busy={busy}
        onCancel={onCancel}
        confirmLabel={busy ? "Creating…" : "Create draft"}
        onConfirm={() => onCreate(subject)}
      />
    </Dialog>
  );
}

/**
 * The one modal shell, so the three dialogs above cannot drift in how they
 * behave. Escape cancels; the backdrop does not, because a stray click next to a
 * confirmation should not dismiss it.
 */
function Dialog({
  label,
  onCancel,
  children,
}: {
  label: string;
  onCancel?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel?.();
        }}
        className="w-full max-w-md rounded border border-[var(--border)] bg-white p-5 shadow-lg"
      >
        {children}
      </div>
    </div>
  );
}

function DialogButtons({
  busy,
  confirmLabel,
  confirmDisabled = false,
  confirmTone = "accent",
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  confirmLabel: string;
  confirmDisabled?: boolean;
  confirmTone?: "accent" | "danger";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="rounded border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-50"
      >
        Cancel
      </button>
      {/* Disabled the instant it is clicked, like the send button: a second
          click while the first is in flight is a second write. */}
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy || confirmDisabled}
        className={
          "rounded px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 " +
          (confirmTone === "danger"
            ? "bg-[var(--phb-maroon)]"
            : "bg-[var(--phb-purple)]")
        }
      >
        {confirmLabel}
      </button>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DerivedDraftMode,
  MessageSummary,
} from "@/lib/modules/change-orders/mail/types";
import { FolderTree } from "./folder-tree";
import { MessageBodyFrame } from "./message-body";
import { DraftEditor, SentConfirmation } from "./draft-editor";
import { AttachmentList } from "./attachments";
import {
  ComposePrompt,
  DeleteConfirmation,
  FolderPicker,
  MessageActions,
} from "./message-actions";
import {
  createDerivedDraft,
  createDraft,
  deleteMessage,
  moveMessage,
} from "./draft-client";
import {
  ApiError,
  ancestorsOf,
  buildFolderTree,
  fetchFolders,
  initiallyExpandedFolderIds,
  fetchMessage,
  fetchMessages,
  isMissing,
  type FolderNode,
  type FolderTreeNode,
  type MessageResult,
} from "./mailbox-client";
import {
  MailErrorState,
  MessageListSkeleton,
  PaneMessage,
  ReadingPaneSkeleton,
} from "./states";

/**
 * The Change Orders mailbox.
 *
 * Phases 4 and 5 made this read-only, and Phase 6 added editing and sending one
 * draft. Phase 8 finished the client: reply, reply-all, forward, move, delete,
 * attachments and compose. What did NOT change is the shape of it - every one of
 * those either produces an unsent draft that opens in the same editor, or is
 * reversible in Exchange.
 *
 * Nothing here is persisted. The mailbox is read live from Exchange on demand,
 * which is why a stale list and a message that has moved are ordinary events
 * rather than errors - Power Automate moves messages constantly.
 *
 * One rule this component holds to that is easy to lose: no action operates on
 * more than the one message somebody is looking at. There is no multi-select,
 * no "apply to all", and above all no send that is not the editor's own.
 */

/** Gentle on purpose. Throttling concentrates on one mailbox, one app identity. */
const POLL_INTERVAL_MS = 60_000;
const PAGE_SIZE = 25;

interface ListState {
  messages: MessageSummary[];
  nextCursor: string | null;
  ordered: boolean;
}

export function MailboxWorkspace() {
  const [folders, setFolders] = useState<FolderNode[] | null>(null);
  const [folderError, setFolderError] = useState<ApiError | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<FolderNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [list, setList] = useState<ListState | null>(null);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<MessageResult | null>(null);
  const [messageError, setMessageError] = useState<ApiError | null>(null);
  const [messageLoading, setMessageLoading] = useState(false);
  const [vanished, setVanished] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sent, setSent] = useState<{ subject: string | null; recipients: string[] } | null>(
    null,
  );

  const [searchInput, setSearchInput] = useState("");
  const [activeQuery, setActiveQuery] = useState("");

  /**
   * Phase 8 actions.
   *
   * One `actionBusy` flag rather than one per action, because only one can be in
   * flight: every control that starts one is disabled while it is set. That is
   * what makes a double-click on Delete impossible to turn into two requests.
   */
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [composing, setComposing] = useState(false);

  /**
   * What just happened to a message that is no longer on screen.
   *
   * A move and a delete both end with the reading pane empty, and an empty pane
   * with no explanation reads as "something went wrong". These say what became
   * of it and, in the move case, that the message is findable again.
   */
  const [moved, setMoved] = useState<{
    subject: string | null;
    idChanged: boolean;
  } | null>(null);
  const [deletedSubject, setDeletedSubject] = useState<string | null>(null);

  const tree = useMemo(
    () => (folders === null ? [] : buildFolderTree(folders)),
    [folders],
  );

  // ---------------------------------------------------------------- folders

  const loadFolders = useCallback(async (signal?: AbortSignal) => {
    try {
      const { folders: loaded } = await fetchFolders(signal);
      setFolders(loaded);
      setFolderError(null);

      setSelectedFolder((current) => {
        if (current !== null) {
          return loaded.find((f) => f.id === current.id) ?? current;
        }
        // PHASE-5: "Default the folder selection to Drafts, not Inbox. That's
        // the job." Reviewing what the automation produced is the daily loop.
        return (
          loaded.find((f) => f.wellKnownName === "drafts") ??
          loaded.find((f) => f.wellKnownName === "inbox") ??
          loaded[0] ??
          null
        );
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof ApiError) setFolderError(error);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadFolders(controller.signal);
    return () => controller.abort();
  }, [loadFolders]);

  /**
   * Open the roots that have children, once, when the tree first arrives.
   *
   * Without this the tree paints fully collapsed, and in this mailbox that hides
   * everything interesting: `Projects` is a child of Inbox, not a top-level
   * folder, so a collapsed Inbox means 8 visible rows out of 19 and no sign that
   * a project hierarchy exists at all. It reads as a truncated tree rather than
   * a closed one.
   *
   * Roots only. Opening every level would put all 19 folders on screen and bury
   * Drafts, which is the folder the default selection just chose.
   *
   * Guarded by a ref so it happens on first load and never again - re-running it
   * would reopen a folder the user deliberately collapsed.
   */
  const didInitialExpand = useRef(false);

  useEffect(() => {
    if (folders === null || didInitialExpand.current) return;
    didInitialExpand.current = true;

    const roots = initiallyExpandedFolderIds(folders);
    if (roots.length > 0) setExpanded((current) => new Set([...current, ...roots]));
  }, [folders]);

  // Open the tree far enough to reveal the selected folder. Drafts is a root,
  // but a project folder is three levels down - selecting one from a search
  // result or a deep link has to reveal where it lives.
  useEffect(() => {
    if (folders === null || selectedFolder === null) return;
    const path = ancestorsOf(folders, selectedFolder.id);
    if (path.length === 0) return;

    setExpanded((current) => {
      const next = new Set(current);
      let changed = false;
      for (const id of path) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [folders, selectedFolder]);

  // --------------------------------------------------------------- messages

  const loadMessages = useCallback(
    async (
      folderId: string,
      query: string,
      { quiet = false, signal }: { quiet?: boolean; signal?: AbortSignal } = {},
    ) => {
      if (!quiet) setListLoading(true);
      try {
        const page = await fetchMessages(
          folderId,
          { query, top: PAGE_SIZE },
          signal,
        );
        setList({
          messages: page.messages,
          nextCursor: page.nextCursor,
          ordered: page.ordered,
        });
        setListError(null);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        // A background poll that fails must not replace a list the user is
        // reading with an error pane. It will be retried on the next tick.
        if (error instanceof ApiError && !quiet) setListError(error);
      } finally {
        if (!quiet) setListLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (selectedFolder === null) return;

    const controller = new AbortController();
    void loadMessages(selectedFolder.id, activeQuery, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [selectedFolder, activeQuery, loadMessages]);

  const loadOlder = useCallback(async () => {
    if (selectedFolder === null || list?.nextCursor == null) return;

    setLoadingMore(true);
    try {
      const page = await fetchMessages(selectedFolder.id, {
        cursor: list.nextCursor,
        query: activeQuery,
        top: PAGE_SIZE,
      });
      setList((current) =>
        current === null
          ? null
          : {
              ...current,
              messages: [...current.messages, ...page.messages],
              nextCursor: page.nextCursor,
            },
      );
    } catch (error) {
      if (error instanceof ApiError) setListError(error);
    } finally {
      setLoadingMore(false);
    }
  }, [selectedFolder, list, activeQuery]);

  // ----------------------------------------------------------------- polling

  const pollRef = useRef<(() => void) | null>(null);
  pollRef.current = () => {
    if (selectedFolder === null) return;
    // A search is a point-in-time question, not a live view; re-running it on a
    // timer would reorder results under the reader.
    if (activeQuery.length > 0) return;
    void loadMessages(selectedFolder.id, "", { quiet: true });
  };

  useEffect(() => {
    // PHASE-5: poll "only while the tab is focused, and stop when it isn't".
    // A background tab polling a shared mailbox is throttling nobody asked for.
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = () => {
      if (timer !== null || document.visibilityState !== "visible") return;
      timer = setInterval(() => pollRef.current?.(), POLL_INTERVAL_MS);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Catch up immediately on return, then resume the interval.
        pollRef.current?.();
        start();
      } else {
        stop();
      }
    };

    start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", stop);
    window.addEventListener("focus", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", stop);
      window.removeEventListener("focus", onVisibility);
    };
  }, []);

  // ------------------------------------------------------------ one message

  const openMessage = useCallback(
    async (id: string, allowRemoteImages = false) => {
      setSelectedId(id);
      setEditing(false);
      setSent(null);
      setMoved(null);
      setDeletedSubject(null);
      setActionError(null);
      setMessageLoading(true);
      setMessageError(null);
      setVanished(false);

      try {
        const result = await fetchMessage(id, { allowRemoteImages });
        setMessage(result);
      } catch (error) {
        if (isMissing(error)) {
          // Normal: Power Automate moves messages, and somebody else may have
          // sent this draft. Clear the pane, refresh the list, no error page.
          setMessage(null);
          setSelectedId(null);
          setVanished(true);
          if (selectedFolder !== null) {
            void loadMessages(selectedFolder.id, activeQuery, { quiet: true });
          }
        } else if (error instanceof ApiError) {
          setMessage(null);
          setMessageError(error);
        }
      } finally {
        setMessageLoading(false);
      }
    },
    [selectedFolder, activeQuery, loadMessages],
  );

  /**
   * Re-reads the message already open, without disturbing what the pane is
   * showing.
   *
   * `openMessage` is the wrong tool for this: it drops out of the editor and
   * clears the sent confirmation, because that is what opening a DIFFERENT
   * message should do. After an attachment changes, the same message is still
   * open and the person is still editing it.
   */
  const refreshOpenMessage = useCallback(async () => {
    const id = selectedId;
    if (id === null) return;

    try {
      setMessage(await fetchMessage(id, {
        allowRemoteImages: message?.remoteImagesAllowed ?? false,
      }));
    } catch (error) {
      if (isMissing(error)) {
        setMessage(null);
        setSelectedId(null);
        setEditing(false);
        setVanished(true);
      }
      // Any other failure leaves the pane as it was. The attachment operation
      // itself already reported its own outcome; replacing a message somebody is
      // editing with an error pane over a failed re-read would lose their work.
    }
  }, [selectedId, message]);

  // ------------------------------------------------------------- actions

  /**
   * Runs one action, and one only.
   *
   * Every Phase 8 action goes through here so that the busy flag, the error
   * handling and the "it vanished" case are written once. A message that is gone
   * is not an error - Power Automate moves things and somebody else may have
   * filed it already.
   */
  const runAction = useCallback(
    async <T,>(
      action: () => Promise<T>,
      onDone: (result: T) => void,
    ): Promise<void> => {
      if (actionBusy) return;

      setActionBusy(true);
      setActionError(null);
      try {
        onDone(await action());
      } catch (error) {
        if (isMissing(error)) {
          setMessage(null);
          setSelectedId(null);
          setEditing(false);
          setVanished(true);
          setPicking(false);
          setDeleting(false);
          if (selectedFolder !== null) {
            void loadMessages(selectedFolder.id, activeQuery, { quiet: true });
          }
        } else if (error instanceof ApiError) {
          setActionError(error.message);
        }
      } finally {
        setActionBusy(false);
      }
    },
    [actionBusy, selectedFolder, activeQuery, loadMessages],
  );

  /**
   * Opens a draft the platform just created, in the Phase 6 editor.
   *
   * The draft is fetched as a message first, because the editor needs the
   * attachment list and the reading pane needs the header - and it is the same
   * request the editor would make anyway. There is deliberately no separate
   * "new draft" pane: reply, forward and compose all land here.
   */
  const openCreatedDraft = useCallback(
    async (draftId: string) => {
      await openMessage(draftId);
      setEditing(true);

      // A reply lands in Drafts, not in the folder being looked at, so the list
      // is refreshed - otherwise the new draft is invisible until the next poll.
      if (selectedFolder !== null) {
        void loadMessages(selectedFolder.id, activeQuery, { quiet: true });
      }
    },
    [openMessage, selectedFolder, activeQuery, loadMessages],
  );

  const respond = useCallback(
    (mode: DerivedDraftMode) => {
      const id = selectedId;
      if (id === null) return;

      void runAction(
        () => createDerivedDraft(id, mode),
        (result) => void openCreatedDraft(result.draft.id),
      );
    },
    [selectedId, runAction, openCreatedDraft],
  );

  const compose = useCallback(
    (subject: string) => {
      void runAction(
        () => createDraft({ subject }),
        (result) => {
          setComposing(false);
          void openCreatedDraft(result.draft.id);
        },
      );
    },
    [runAction, openCreatedDraft],
  );

  const move = useCallback(
    (destinationFolderId: string) => {
      const id = selectedId;
      if (id === null) return;

      void runAction(
        () => moveMessage(id, destinationFolderId),
        (result) => {
          setPicking(false);
          setEditing(false);
          setMessage(null);
          // The id survives the move - immutable ids are requested on every
          // request - but the list is now wrong, and the message is no longer in
          // the folder being shown. Clearing the pane is the honest state.
          setSelectedId(null);
          setMoved({ subject: result.subject, idChanged: result.idChanged });
          if (selectedFolder !== null) {
            void loadMessages(selectedFolder.id, activeQuery, { quiet: true });
          }
        },
      );
    },
    [selectedId, runAction, selectedFolder, activeQuery, loadMessages],
  );

  const remove = useCallback(() => {
    const id = selectedId;
    if (id === null) return;

    void runAction(
      () => deleteMessage(id),
      (result) => {
        setDeleting(false);
        setEditing(false);
        setMessage(null);
        setSelectedId(null);
        setDeletedSubject(result.subject);
        if (selectedFolder !== null) {
          void loadMessages(selectedFolder.id, activeQuery, { quiet: true });
        }
      },
    );
  }, [selectedId, runAction, selectedFolder, activeQuery, loadMessages]);

  const selectFolder = useCallback((folder: FolderTreeNode) => {
    setSelectedFolder(folder);
    setSelectedId(null);
    setMessage(null);
    setMessageError(null);
    setVanished(false);
    setEditing(false);
    setSent(null);
    setMoved(null);
    setDeletedSubject(null);
    setActionError(null);
    setSearchInput("");
    setActiveQuery("");
  }, []);

  const toggleFolder = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // The mailbox being unconfigured is a whole-module state, not a per-pane one.
  if (folderError?.code === "mail_not_configured") {
    return (
      <div className="flex h-full items-center justify-center rounded border border-[var(--border)]">
        <MailErrorState code={folderError.code} message={folderError.message} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded border border-[var(--border)] bg-[var(--surface)]">
      {/* Folders */}
      <div className="flex w-52 shrink-0 flex-col border-r border-[var(--border)]">
        <PaneHeader>Folders</PaneHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {folderError !== null ? (
            <MailErrorState
              code={folderError.code}
              message={folderError.message}
              onRetry={() => void loadFolders()}
            />
          ) : folders === null ? (
            <FolderSkeleton />
          ) : (
            <FolderTree
              nodes={tree}
              selectedId={selectedFolder?.id ?? null}
              expandedIds={expanded}
              onSelect={selectFolder}
              onToggle={toggleFolder}
            />
          )}
        </div>
      </div>

      {/* Message list */}
      <div className="flex w-80 shrink-0 flex-col border-r border-[var(--border)] bg-white">
        <PaneHeader>
          <span className="truncate">{selectedFolder?.displayName ?? "Messages"}</span>
          {/*
            Composing is the least-used entry point in this module - most
            change-order mail originates from the automation - so it sits here
            rather than anywhere more prominent. It creates a draft; it does not
            open anything that can send.
          */}
          <button
            type="button"
            disabled={actionBusy}
            onClick={() => {
              setActionError(null);
              setComposing(true);
            }}
            className="ml-auto shrink-0 rounded border border-[var(--border)] bg-white px-2 py-0.5 text-[0.7rem] font-medium normal-case tracking-normal hover:bg-[var(--surface)] disabled:opacity-50"
          >
            New message
          </button>
        </PaneHeader>

        <form
          className="border-b border-[var(--border)] p-2"
          onSubmit={(event) => {
            event.preventDefault();
            setActiveQuery(searchInput.trim());
          }}
        >
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search subjects in this folder"
            aria-label="Search subjects in this folder"
            className="w-full rounded border border-[var(--border)] px-2 py-1.5 text-sm"
          />
        </form>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {listError !== null ? (
            <MailErrorState
              code={listError.code}
              message={listError.message}
              onRetry={() => {
                if (selectedFolder !== null) {
                  void loadMessages(selectedFolder.id, activeQuery);
                }
              }}
            />
          ) : listLoading || list === null ? (
            <MessageListSkeleton />
          ) : list.messages.length === 0 ? (
            <PaneMessage
              title={activeQuery.length > 0 ? "No matches" : "Nothing to review"}
              detail={
                activeQuery.length > 0
                  ? `Nothing in ${selectedFolder?.displayName ?? "this folder"} matches “${activeQuery}”.`
                  : "This folder is empty. Drafts the automation creates will appear here."
              }
            />
          ) : (
            <>
              {!list.ordered && (
                <p className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-1.5 text-xs text-[var(--muted)]">
                  Matched on subject, and not in date order. Search does not look
                  inside messages — clear the box for the full folder, newest
                  first.
                </p>
              )}
              <ul className="divide-y divide-[var(--border)]">
                {list.messages.map((m) => (
                  <MessageRow
                    key={m.id}
                    message={m}
                    selected={m.id === selectedId}
                    onOpen={() => void openMessage(m.id)}
                  />
                ))}
              </ul>
              {list.nextCursor !== null && (
                <div className="p-3">
                  <button
                    type="button"
                    disabled={loadingMore}
                    onClick={() => void loadOlder()}
                    className="w-full rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface)] disabled:opacity-50"
                  >
                    {loadingMore ? "Loading…" : "Load older messages"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Reading pane. Relative, so the send confirmation can cover it. */}
      <div className="relative flex min-w-0 flex-1 flex-col bg-white">
        {sent !== null ? (
          <SentConfirmation
            summary={sent}
            onDismiss={() => {
              setSent(null);
              setSelectedId(null);
              setMessage(null);
              if (selectedFolder !== null) {
                void loadMessages(selectedFolder.id, activeQuery, { quiet: true });
              }
            }}
          />
        ) : moved !== null ? (
          <PaneMessage
            title="Moved"
            detail={
              `“${moved.subject ?? "(no subject)"}” is now in the folder you chose. ` +
              `It is in that folder in Outlook too.` +
              // Should never appear. If it does, immutable ids have stopped
              // taking effect and every id the browser holds is a move away
              // from being stale - so it says so rather than hiding it.
              (moved.idChanged
                ? " Its identifier changed during the move, which is unexpected — tell IT."
                : "")
            }
            action={
              <button
                type="button"
                onClick={() => setMoved(null)}
                className="rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface)]"
              >
                Back to the list
              </button>
            }
          />
        ) : deletedSubject !== null ? (
          <PaneMessage
            title="Moved to Deleted Items"
            detail={`“${deletedSubject}” is in Deleted Items in changeorder@phb1899.com. Drag it back in Outlook if that was a mistake.`}
            action={
              <button
                type="button"
                onClick={() => setDeletedSubject(null)}
                className="rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface)]"
              >
                Back to the list
              </button>
            }
          />
        ) : vanished ? (
          <PaneMessage
            title="That message is no longer here"
            detail="It was moved or sent while this list was open. The list has been refreshed."
          />
        ) : messageError !== null ? (
          <MailErrorState
            code={messageError.code}
            message={messageError.message}
            onRetry={() => selectedId !== null && void openMessage(selectedId)}
          />
        ) : messageLoading ? (
          <ReadingPaneSkeleton />
        ) : message === null ? (
          <PaneMessage
            title="No message selected"
            detail="Choose a message from the list to read it."
          />
        ) : editing && message.message.isDraft ? (
          /**
           * A draft opens in the editor; anything already sent is read-only.
           * The service refuses to edit a non-draft regardless, so this is the
           * convenience, not the control.
           */
          <DraftEditor
            messageId={message.message.id}
            attachments={message.attachments}
            remoteImagesAllowed={message.remoteImagesAllowed}
            onShowImages={() => void openMessage(message.message.id, true)}
            onAttachmentsChanged={() => void refreshOpenMessage()}
            onClose={() => setEditing(false)}
            onSent={(summary) => {
              setSent(summary);
              setEditing(false);
              // The draft no longer exists. Refresh so the list agrees.
              if (selectedFolder !== null) {
                void loadMessages(selectedFolder.id, activeQuery, { quiet: true });
              }
            }}
            onGone={() => {
              setEditing(false);
              setMessage(null);
              setSelectedId(null);
              setVanished(true);
              if (selectedFolder !== null) {
                void loadMessages(selectedFolder.id, activeQuery, { quiet: true });
              }
            }}
          />
        ) : (
          <MessageView
            result={message}
            onShowImages={() => void openMessage(message.message.id, true)}
            onEdit={
              message.message.isDraft ? () => setEditing(true) : undefined
            }
            actionBusy={actionBusy}
            actionError={actionError}
            onRespond={respond}
            onMove={() => {
              setActionError(null);
              setPicking(true);
            }}
            onDelete={() => {
              setActionError(null);
              setDeleting(true);
            }}
          />
        )}

        {/*
          The dialogs sit inside the reading pane, which is `relative`, so each
          covers the message it is about rather than the whole application. Only
          one can be open: each is opened from a control the others disable.
        */}
        {picking && folders !== null && (
          <FolderPicker
            folders={folders}
            currentFolderId={message?.message.parentFolderId ?? null}
            busy={actionBusy}
            error={actionError}
            onCancel={() => {
              setPicking(false);
              setActionError(null);
            }}
            onConfirm={(folder) => move(folder.id)}
          />
        )}

        {deleting && (
          <DeleteConfirmation
            subject={message?.message.subject ?? null}
            busy={actionBusy}
            error={actionError}
            onCancel={() => {
              setDeleting(false);
              setActionError(null);
            }}
            onConfirm={remove}
          />
        )}

        {composing && (
          <ComposePrompt
            busy={actionBusy}
            error={actionError}
            onCancel={() => {
              setComposing(false);
              setActionError(null);
            }}
            onCreate={compose}
          />
        )}
      </div>
    </div>
  );
}

function PaneHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
      {children}
    </div>
  );
}

function FolderSkeleton() {
  return (
    <div className="space-y-2 p-3" aria-hidden="true">
      {Array.from({ length: 7 }, (_, i) => (
        <div
          key={i}
          className="h-4 animate-pulse rounded bg-[var(--border)]"
          style={{ width: `${85 - (i % 3) * 15}%` }}
        />
      ))}
    </div>
  );
}

function MessageRow({
  message,
  selected,
  onOpen,
}: {
  message: MessageSummary;
  selected: boolean;
  onOpen: () => void;
}) {
  // Real subjects are long and repetitive - "[CCHMC Bulletin 12] Change Order
  // Request — Additional Information Needed". Two lines of subject beats one
  // truncated line, because the distinguishing part is often at the end.
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className={
          "block w-full px-4 py-3 text-left hover:bg-[var(--surface)] " +
          (selected ? "bg-[var(--surface)]" : "")
        }
      >
        <p
          className={
            "line-clamp-2 text-sm " + (message.isRead ? "" : "font-semibold")
          }
          title={message.subject ?? undefined}
        >
          {message.subject ?? "(no subject)"}
        </p>
        <p className="mt-1 truncate text-xs text-[var(--muted)]">
          {message.isDraft
            ? `To ${describeRecipients(message)}`
            : (message.from?.name ?? message.from?.address ?? "Unknown sender")}
        </p>
        <p className="mt-0.5 flex items-center gap-2 text-xs text-[var(--muted)]">
          <span>{formatDate(message.receivedDateTime)}</span>
          {message.hasAttachments && <span title="Has attachments">📎</span>}
          {message.isDraft && (
            <span className="rounded bg-amber-100 px-1.5 text-[0.625rem] font-medium text-amber-900">
              Draft
            </span>
          )}
        </p>
      </button>
    </li>
  );
}

function describeRecipients(message: MessageSummary): string {
  if (message.to.length === 0) return "no recipient";
  const first = message.to[0];
  const name = first?.name ?? first?.address ?? "unknown";
  return message.to.length === 1 ? name : `${name} +${message.to.length - 1}`;
}

function MessageView({
  result,
  onShowImages,
  onEdit,
  actionBusy,
  actionError,
  onRespond,
  onMove,
  onDelete,
}: {
  result: MessageResult;
  onShowImages: () => void;
  onEdit?: () => void;
  actionBusy: boolean;
  actionError: string | null;
  onRespond: (mode: DerivedDraftMode) => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const { message, attachments, remoteImagesAllowed } = result;

  return (
    <>
      <div className="shrink-0 border-b border-[var(--border)] px-6 py-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold" title={message.subject ?? undefined}>
            {message.subject ?? "(no subject)"}
          </h2>
          {onEdit !== undefined && (
            <button
              type="button"
              onClick={onEdit}
              className="shrink-0 rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface)]"
            >
              Review and edit
            </button>
          )}
        </div>

        <div className="mt-3">
          <MessageActions
            busy={actionBusy}
            // Replying to a draft is not a meaningful thing to do, and Graph
            // refuses it. Move and delete still apply.
            canRespond={!message.isDraft}
            onRespond={onRespond}
            onMove={onMove}
            onDelete={onDelete}
          />
          {actionError !== null && (
            <p role="alert" className="mt-2 text-xs text-red-700">
              {actionError}
            </p>
          )}
        </div>

        <dl className="mt-3 space-y-1 text-sm">
          <AddressRow label="From" addresses={message.from === null ? [] : [message.from]} />
          <AddressRow label="To" addresses={message.to} />
          <AddressRow label="Cc" addresses={message.cc} />
          <div className="flex gap-2">
            <dt className="w-10 shrink-0 text-xs text-[var(--muted)]">Date</dt>
            <dd className="text-[var(--muted)]">
              {formatDateTime(message.sentDateTime ?? message.receivedDateTime)}
            </dd>
          </div>
        </dl>

        {/*
          Downloadable as of Phase 8. The bytes stream through the backend from
          Graph and are never written anywhere - the alternative would have been
          handing the browser a Graph URL, which needs the app-only token
          attached, and a token in a browser can read the whole mailbox.
        */}
        <AttachmentList messageId={message.id} attachments={attachments} />
      </div>

      <MessageBodyFrame
        body={message.body}
        remoteImagesAllowed={remoteImagesAllowed}
        onShowImages={onShowImages}
      />
    </>
  );
}

function AddressRow({
  label,
  addresses,
}: {
  label: string;
  addresses: { name: string | null; address: string }[];
}) {
  if (addresses.length === 0) return null;

  return (
    <div className="flex gap-2">
      <dt className="w-10 shrink-0 text-xs text-[var(--muted)]">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">
        {addresses.map((a) => a.name ?? a.address).join(", ")}
      </dd>
    </div>
  );
}

function formatDate(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  return sameDay
    ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDateTime(value: string | null): string {
  if (value === null) return "Unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";

  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

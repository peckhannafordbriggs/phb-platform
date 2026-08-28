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
  describeUnexpected,
  ancestorsOf,
  buildFolderTree,
  fetchFolders,
  initiallyExpandedFolderIds,
  fetchMessage,
  fetchMessages,
  isMissing,
  conversationIdOf,
  conversationRows,
  truncationNotice,
  type ConversationRow as ConversationRowModel,
  type FolderNode,
  type FolderTreeNode,
  type MessageResult,
  type RetryNotice,
} from "./mailbox-client";
import {
  MailErrorState,
  MessageListSkeleton,
  PaneMessage,
  ReadingPaneSkeleton,
} from "./states";
import type {
  ConversationGroup,
  ConversationTruncation,
} from "@/lib/modules/change-orders/mail/types";
import { splitSubjectTag } from "@/lib/modules/change-orders/mail/subject-tag";

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

/**
 * How often the open folder is re-read while the tab is visible.
 *
 * Twenty seconds, chosen against a measurement rather than a feeling. Phase 9
 * timed a platform write becoming visible in a folder listing: it was there on
 * the first 250ms poll, every time. Exchange is not the slow part - this
 * interval was the entire user-visible delay, which is why it, and not a
 * subscription lifecycle, is where the latency was bought back. See
 * docs/phase-9-verification.md.
 *
 * The cost, against the ~10,000 requests per 10 minutes per app per mailbox that
 * Exchange allows (runbook.md, *Graph throttling*):
 *
 *   one focused tab   1 request / 20s  =   30 per 10 min  =  0.3% of budget
 *   three focused     90 per 10 min                       =  0.9% of budget
 *
 * 180 requests an hour per focused tab. One request per poll, because every
 * folder in this mailbox fits inside a single page of 100 - a folder that grew
 * past that would make a grouped poll up to 5 sequential requests, so 1.5% per
 * tab, still nowhere near the ceiling. The 4-concurrent-per-mailbox limit is
 * untouched either way: a poll is sequential and one tab never has more than one
 * request in flight.
 *
 * Two things keep this honest and both are load-bearing:
 *
 *   - It runs **only while the tab is visible**. A backgrounded tab costs
 *     nothing, which is what stops a forgotten tab being the real bill.
 *   - Tripling the poll rate triples the rate at which this component
 *     re-renders, and the editor used to reset itself on every parent render -
 *     the 60-second version of that bug is written up in runbook.md. The
 *     callbacks ref in draft-editor.tsx is what makes a faster interval safe;
 *     do not remove it.
 *
 * If throttling ever does become a problem, raise this before touching the retry
 * path.
 */
const POLL_INTERVAL_MS = 20_000;
const PAGE_SIZE = 25;

/**
 * How long a request may take before the pane admits it is still working.
 *
 * A throttled request is retried once inside the server, after honouring
 * Retry-After - which can be up to thirty seconds inside a single HTTP request,
 * during which the browser has nothing to show. This is the "not frozen, just
 * slow" hint; the response itself then says whether it was actually a throttle.
 */
const SLOW_REQUEST_MS = 2_500;

/**
 * Grouping defaults ON, and is remembered per browser.
 *
 * PHASE-9: default on, because a thread is the unit people reason about. The
 * toggle exists for someone hunting one specific message - and, less obviously,
 * as the escape hatch for a folder that has outgrown the grouping cap, since
 * flat mode is the paged one.
 */
const GROUPING_STORAGE_KEY = "phb.change-orders.group-conversations";

interface ListState {
  /** Which shape came back. Grouped responses carry no cursor. */
  grouped: boolean;
  /** Null in flat mode. */
  conversations: ConversationGroup[] | null;
  /** Empty in grouped mode - the messages live inside the conversations. */
  messages: MessageSummary[];
  nextCursor: string | null;
  /** A capped listing. A flat folder listing pages instead, and never sets it. */
  truncated: boolean;
  truncation: ConversationTruncation | null;
  /** Set when Graph throttled something behind this response. */
  retry: RetryNotice | null;
}

/** Every message in the list, whichever shape the response had. */
function messagesOf(list: ListState | null): MessageSummary[] {
  if (list === null) return [];
  if (list.conversations === null) return list.messages;
  return list.conversations.flatMap((c) => c.messages);
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
  /**
   * A failed "load older" must not replace the messages already on screen with
   * an error pane - that would throw away work in order to report a failure. It
   * is shown beside the button that failed, which still offers another go.
   */
  const [olderError, setOlderError] = useState<string | null>(null);
  const [listSlow, setListSlow] = useState(false);

  const [grouped, setGrouped] = useState(true);
  const [expandedConversations, setExpandedConversations] = useState<Set<string>>(
    new Set(),
  );

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
      group: boolean,
      { quiet = false, signal }: { quiet?: boolean; signal?: AbortSignal } = {},
    ) => {
      if (!quiet) setListLoading(true);

      // "Still working" rather than a frozen pane. A throttled request is
      // retried once inside the server, after waiting out Retry-After, and the
      // browser cannot see that happening - only that nothing has come back.
      const slowTimer = setTimeout(() => setListSlow(true), SLOW_REQUEST_MS);

      try {
        const page = await fetchMessages(
          folderId,
          // A grouped read has no cursor and ignores `top`; fetchMessages drops
          // the paging options rather than sending ones the server discards.
          { query, top: PAGE_SIZE, group },
          signal,
        );
        setList({
          grouped: page.grouped,
          conversations: page.conversations,
          messages: page.messages,
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          truncation: page.truncation,
          retry: page.retry,
        });
        setListError(null);
        setOlderError(null);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        // A background poll that fails must not replace a list the user is
        // reading with an error pane. It will be retried on the next tick.
        if (error instanceof ApiError && !quiet) setListError(error);
      } finally {
        clearTimeout(slowTimer);
        setListSlow(false);
        if (!quiet) setListLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (selectedFolder === null) return;

    const controller = new AbortController();
    void loadMessages(selectedFolder.id, activeQuery, grouped, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [selectedFolder, activeQuery, grouped, loadMessages]);

  /**
   * The grouping preference, remembered per browser.
   *
   * Read in an effect rather than in the initial state so the server and the
   * first client render agree - reading localStorage during render is a
   * hydration mismatch. The cost is one extra fetch in the rare case where the
   * stored value is `off`, which is preferable to a flash of the wrong list.
   */
  useEffect(() => {
    try {
      if (window.localStorage.getItem(GROUPING_STORAGE_KEY) === "off") {
        setGrouped(false);
      }
    } catch {
      // Storage disabled or unavailable. The default stands.
    }
  }, []);

  const toggleGrouping = useCallback(() => {
    setGrouped((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(GROUPING_STORAGE_KEY, next ? "on" : "off");
      } catch {
        // Not remembering the preference is not worth failing over.
      }
      return next;
    });
    // Expansion is meaningless across a mode change, and a stale set would
    // silently re-expand unrelated threads when grouping came back on.
    setExpandedConversations(new Set());
  }, []);

  const toggleConversation = useCallback((conversationId: string) => {
    setExpandedConversations((current) => {
      const next = new Set(current);
      if (next.has(conversationId)) next.delete(conversationId);
      else next.add(conversationId);
      return next;
    });
  }, []);

  /**
   * Keep the open message's conversation expanded.
   *
   * Without this, opening a message from a search, then switching back to the
   * folder, leaves the reading pane showing a message whose row is folded away -
   * which reads as the list having lost it.
   */
  useEffect(() => {
    if (selectedId === null || list?.conversations == null) return;

    const conversationId = conversationIdOf(list.conversations, selectedId);
    if (conversationId === null) return;

    setExpandedConversations((current) =>
      current.has(conversationId) ? current : new Set(current).add(conversationId),
    );
  }, [selectedId, list]);

  /**
   * The next page, in flat mode only.
   *
   * Grouped mode has no cursor: it collects the folder to a cap and groups the
   * complete set, because a group assembled from one page states a message count
   * that is wrong. Turning grouping off is how someone pages back through a
   * folder that has outgrown that cap.
   */
  const loadOlder = useCallback(async () => {
    if (selectedFolder === null || list?.nextCursor == null) return;

    setLoadingMore(true);
    setOlderError(null);
    try {
      const page = await fetchMessages(selectedFolder.id, {
        cursor: list.nextCursor,
        query: activeQuery,
        top: PAGE_SIZE,
        group: false,
      });
      setList((current) =>
        current === null
          ? null
          : {
              ...current,
              messages: [...current.messages, ...page.messages],
              nextCursor: page.nextCursor,
              retry: page.retry ?? current.retry,
            },
      );
    } catch (error) {
      // Deliberately NOT setListError: that swaps the whole pane for an error
      // state and discards every message already loaded. The failure belongs
      // next to the button that failed.
      setOlderError(
        error instanceof ApiError
          ? error.message
          : describeUnexpected(error, "loading older messages"),
      );
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
    /**
     * Nor when someone has paged back through a flat folder.
     *
     * A poll re-reads the FIRST page, so refreshing here would silently discard
     * every older page they had loaded - a successful poll destroying work is no
     * better than a failed one doing it. A deep scroll is a deliberate act, like
     * a search, and the folder can be reselected to go live again. Grouped mode
     * has no pages to lose, so it keeps polling.
     */
    if (!grouped && (list?.messages.length ?? 0) > PAGE_SIZE) return;
    // Quiet: a failed poll leaves the list exactly as it is. Expansion state
    // lives in a Set of conversation ids, so a poll that returns the same
    // threads leaves them open.
    void loadMessages(selectedFolder.id, "", grouped, { quiet: true });
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
            void loadMessages(selectedFolder.id, activeQuery, grouped, { quiet: true });
          }
        } else if (error instanceof ApiError) {
          setMessage(null);
          setMessageError(error);
        } else {
          setMessage(null);
          setMessageError(
            new ApiError("unexpected", describeUnexpected(error, "opening a message")),
          );
        }
      } finally {
        setMessageLoading(false);
      }
    },
    [selectedFolder, activeQuery, grouped, loadMessages],
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
            void loadMessages(selectedFolder.id, activeQuery, grouped, { quiet: true });
          }
        } else if (error instanceof ApiError) {
          setActionError(error.message);
        } else {
          // Not an ApiError, so this is our bug rather than the mailbox's.
          // Saying so beats the button appearing to do nothing.
          setActionError(describeUnexpected(error, "action failed"));
        }
      } finally {
        setActionBusy(false);
      }
    },
    [actionBusy, selectedFolder, activeQuery, grouped, loadMessages],
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
        void loadMessages(selectedFolder.id, activeQuery, grouped, { quiet: true });
      }
    },
    [openMessage, selectedFolder, activeQuery, grouped, loadMessages],
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
            void loadMessages(selectedFolder.id, activeQuery, grouped, { quiet: true });
          }
        },
      );
    },
    [selectedId, runAction, selectedFolder, activeQuery, grouped, loadMessages],
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
          void loadMessages(selectedFolder.id, activeQuery, grouped, { quiet: true });
        }
      },
    );
  }, [selectedId, runAction, selectedFolder, activeQuery, grouped, loadMessages]);

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

  /**
   * The rows to render, in either mode.
   *
   * The grouped case is derived by conversationRows(), which is where the rule
   * that matters lives: a collapsed group still emits its drafts. Flat mode is
   * the same shape with every row un-indented, so there is one rendering path
   * rather than two that have to be kept in step.
   */
  const rows = useMemo<ConversationRowModel[]>(() => {
    if (list === null) return [];
    if (list.conversations !== null) {
      return conversationRows(list.conversations, expandedConversations);
    }
    return list.messages.map((message) => ({
      kind: "message" as const,
      message,
      indented: false,
    }));
  }, [list, expandedConversations]);

  /** Messages on screen, however they are arranged. */
  const shownCount = useMemo(() => messagesOf(list).length, [list]);

  /**
   * Not being connected to the mailbox is a whole-module state, not a per-pane
   * one - three panes each reporting the same broken credential is noise.
   *
   * `mail_auth_failed` and `mail_access_denied` join it here for Phase 9: an
   * expired or rejected credential is the same situation as an unconfigured one
   * from the employee's side, and both have the same answer, which is Outlook.
   */
  if (
    folderError !== null &&
    ["mail_not_configured", "mail_auth_failed", "mail_access_denied"].includes(
      folderError.code,
    )
  ) {
    return (
      <div className="flex h-full items-center justify-center rounded border border-[var(--border)]">
        <MailErrorState
          code={folderError.code}
          message={folderError.message}
          onRetry={() => void loadFolders()}
        />
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

          {/*
            Grouping is on by default and off is a real mode, not a degraded
            one: flat is the paged listing, so it is also how someone gets past
            the grouping cap in a folder that has outgrown it.
          */}
          <label className="mt-2 flex items-center gap-2 text-xs text-[var(--muted)]">
            <input
              type="checkbox"
              checked={grouped}
              onChange={toggleGrouping}
              className="h-3.5 w-3.5"
            />
            Group into conversations
          </label>
        </form>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {listError !== null ? (
            <MailErrorState
              code={listError.code}
              message={listError.message}
              onRetry={() => {
                if (selectedFolder !== null) {
                  void loadMessages(selectedFolder.id, activeQuery, grouped);
                }
              }}
            />
          ) : listLoading || list === null ? (
            <MessageListSkeleton />
          ) : shownCount === 0 ? (
            <PaneMessage
              // The one state that must read as an ordinary Tuesday rather than
              // as something wrong. Drafts is empty for most of the working day.
              calm
              title={activeQuery.length > 0 ? "No matches" : "Nothing to review"}
              detail={
                activeQuery.length > 0
                  ? `Nothing in ${selectedFolder?.displayName ?? "this folder"} matches “${activeQuery}”.`
                  : "This folder is empty. Drafts the automation creates will appear here."
              }
            />
          ) : (
            <>
              {/*
                Said after the fact, because it can only be said after the fact:
                the retry happened inside the one request the browser made, so by
                the time this renders the wait is already over. It is here so a
                pane that sat still for ten seconds has a stated reason rather
                than an implied fault.
              */}
              {list.retry !== null && (
                <p className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900">
                  The mailbox was busy. That took an extra{" "}
                  {list.retry.waitedSeconds}s while the request was retried.
                </p>
              )}

              {/*
                Both listings are newest-first, so there is nothing to warn
                about on ordering any more - the service sorts a search's whole
                result set because Graph will not order a filtered collection.
                What is still worth saying is what a search matched on, and
                whether it returned everything.
              */}
              {activeQuery.length > 0 && (
                <p className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-1.5 text-xs text-[var(--muted)]">
                  {shownCount === 1 ? "1 subject match" : `${shownCount} subject matches`}
                  , newest first. Search does not look inside messages.
                </p>
              )}

              {/*
                The one banner this phase exists to get right.
                
                Two different wordings for two different promises - a folder cap
                dropped the OLDEST messages, a search cap dropped an arbitrary
                subset - because a group that silently hides messages is the
                failure this codebase cares about most, and a group that
                describes what it is hiding wrongly is the same failure wearing a
                notice. truncationNotice() owns which sentence applies.
              */}
              {truncationNotice(list.truncation, shownCount) !== null && (
                <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
                  {truncationNotice(list.truncation, shownCount)}
                </p>
              )}

              <ul className="divide-y divide-[var(--border)]">
                {rows.map((row) =>
                  row.kind === "group" ? (
                    <ConversationHeaderRow
                      key={row.group.id}
                      group={row.group}
                      expanded={row.expanded}
                      hiddenCount={row.hiddenCount}
                      containsSelected={
                        selectedId !== null &&
                        row.group.messages.some((m) => m.id === selectedId)
                      }
                      onToggle={() => toggleConversation(row.group.id)}
                    />
                  ) : (
                    <MessageRow
                      key={row.message.id}
                      message={row.message}
                      selected={row.message.id === selectedId}
                      indented={row.indented}
                      onOpen={() => void openMessage(row.message.id)}
                    />
                  ),
                )}
              </ul>

              {/*
                Flat mode only. A grouped read has no cursor: it collected the
                folder to a cap and grouped the complete set, so there is no
                "next page" that would not corrupt the counts on screen.
              */}
              {list.nextCursor !== null && (
                <div className="space-y-2 p-3">
                  {olderError !== null && (
                    <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                      {olderError} The messages already loaded are still here.
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={loadingMore}
                    onClick={() => void loadOlder()}
                    className="w-full rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface)] disabled:opacity-50"
                  >
                    {loadingMore
                      ? "Loading…"
                      : olderError !== null
                        ? "Try again"
                        : "Load older messages"}
                  </button>
                </div>
              )}
            </>
          )}

          {/*
            Live, unlike the retry banner above: this is what the pane says
            WHILE a request is outstanding and slow, which is the half of a
            throttle the browser can actually observe.
          */}
          {listSlow && (
            <p className="px-4 py-2 text-xs text-[var(--muted)]" role="status">
              Still loading — the mailbox may be busy.
            </p>
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
                void loadMessages(selectedFolder.id, activeQuery, grouped, { quiet: true });
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
            // A message that will not open must not be a dead end: clearing the
            // selection returns to a working pane rather than leaving the error
            // in place until somebody guesses to click another row.
            onBack={() => {
              setMessageError(null);
              setSelectedId(null);
              setMessage(null);
            }}
          />
        ) : messageLoading ? (
          <ReadingPaneSkeleton />
        ) : message === null ? (
          <PaneMessage
            calm
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
                void loadMessages(selectedFolder.id, activeQuery, grouped, { quiet: true });
              }
            }}
            onGone={() => {
              setEditing(false);
              setMessage(null);
              setSelectedId(null);
              setVanished(true);
              if (selectedFolder !== null) {
                void loadMessages(selectedFolder.id, activeQuery, grouped, { quiet: true });
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
  indented = false,
  onOpen,
}: {
  message: MessageSummary;
  selected: boolean;
  /** A message inside a conversation, rather than a row of its own. */
  indented?: boolean;
  onOpen: () => void;
}) {
  /**
   * Real subjects are long and near-identical, and what distinguishes them is a
   * bracket at the front: `[CCHMC Bulletin 12] Change Order Request —
   * Additional Information Needed`. Pulling that bracket out as its own element
   * is the one change worth making to this surface - it is the thing people
   * scan for, and buried at the head of a sixty-character line it may as well
   * not be there.
   *
   * The subject is not edited. splitSubjectTag returns two views of one string
   * and the whole original stays in the title attribute.
   *
   * Two lines of subject beats one truncated line, because the distinguishing
   * part is often at the END - two subjects can share their first forty
   * characters and differ only in the due date.
   */
  const { tag, rest } = splitSubjectTag(message.subject);
  const unread = !message.isRead && !message.isDraft;

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className={
          "relative block w-full py-2.5 text-left transition-colors hover:bg-[var(--neutral-50)] " +
          (indented ? "border-l border-[var(--border)] pl-5 pr-3 " : "px-3 ") +
          (selected ? "bg-[var(--neutral-100)]" : "")
        }
      >
        {/*
          Selection is a rule in the module's colour, not a coloured background.
          A filled row would be the accent filling an area, which the brief rules
          out - and against a vendor's own message colours it would compete.
        */}
        {selected && (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-[2px]"
            style={{ background: "var(--module-accent, var(--phb-purple))" }}
          />
        )}

        {tag !== null && (
          <span className="mb-1 inline-block max-w-full truncate rounded-[2px] bg-[var(--neutral-100)] px-1.5 py-px font-mono text-[0.625rem] leading-4 text-[var(--neutral-700)]">
            {tag}
          </span>
        )}

        <p
          className={"line-clamp-2 text-[0.8125rem] leading-snug " + (unread ? "font-semibold" : "")}
          title={message.subject ?? undefined}
        >
          {rest.length > 0 ? rest : "(no subject)"}
        </p>

        <p className="mt-1 flex items-center gap-1.5 truncate text-[0.6875rem] text-[var(--muted)]">
          <span className="truncate">
            {message.isDraft
              ? `To ${describeRecipients(message)}`
              : (message.from?.name ?? message.from?.address ?? "Unknown sender")}
          </span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 font-mono tabular-nums">
            {formatDate(message.receivedDateTime)}
          </span>
          {message.hasAttachments && <AttachmentGlyph />}
          {message.isDraft && (
            <span
              className="shrink-0 rounded-[2px] px-1 py-px text-[0.5625rem] font-medium uppercase tracking-wide"
              style={{
                color: "var(--phb-orange-ink)",
                background: "color-mix(in srgb, var(--phb-orange) 20%, transparent)",
              }}
            >
              Draft
            </span>
          )}
        </p>
      </button>
    </li>
  );
}

/**
 * The attachment marker.
 *
 * An inline SVG rather than the 📎 emoji it replaces: an emoji renders at the
 * mercy of the platform's font, arrives in full colour into a surface the brief
 * asks to keep near-monochrome, and cannot be told to match the muted text
 * beside it.
 */
function AttachmentGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="Has attachments"
    >
      <path d="M10.5 5.5 6 10a1.5 1.5 0 0 0 2.1 2.1l4.6-4.6a3 3 0 0 0-4.2-4.2L3.8 7.9a4.5 4.5 0 0 0 6.4 6.4l3.6-3.6" />
    </svg>
  );
}

/**
 * The collapsed (or expanded) header for one conversation.
 *
 * A header, not a target. It toggles disclosure and does nothing else - there is
 * no action anywhere that takes a conversation, because the moment a group can
 * be acted on as a unit the one-human-one-message rule is at risk. CLAUDE.md,
 * and PHASE-9 repeats it.
 *
 * A single-message conversation never reaches here: conversationRows() emits it
 * as an ordinary MessageRow, so a folder of unrelated drafts does not become a
 * folder of groups of one.
 */
function ConversationHeaderRow({
  group,
  expanded,
  hiddenCount,
  containsSelected,
  onToggle,
}: {
  group: ConversationGroup;
  expanded: boolean;
  hiddenCount: number;
  containsSelected: boolean;
  onToggle: () => void;
}) {
  /**
   * Separated with a middle dot, not a comma.
   *
   * Exchange returns display names in "Last, First" form for a good number of
   * senders in this mailbox - `Horvath, Brian` is a real one - so a comma-joined
   * list reads as twice as many people as it contains.
   */
  const participants = group.participants
    .map((p) => p.name ?? p.address)
    .join(" · ");

  // Same treatment as a message row: the bracket is what people scan for.
  const { tag, rest } = splitSubjectTag(group.subject);

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={
          "block w-full px-4 py-3 text-left hover:bg-[var(--surface)] " +
          (containsSelected ? "bg-[var(--surface)]" : "")
        }
      >
        {tag !== null && (
          <span className="mb-1 ml-5 inline-block max-w-full truncate rounded-[2px] bg-[var(--neutral-100)] px-1.5 py-px font-mono text-[0.625rem] leading-4 text-[var(--neutral-700)]">
            {tag}
          </span>
        )}
        <p className="flex items-start gap-1.5">
          <span
            aria-hidden="true"
            className="mt-px shrink-0 text-[0.6875rem] text-[var(--muted)]"
          >
            {expanded ? "▾" : "▸"}
          </span>
          <span
            className={
              "line-clamp-2 text-[0.8125rem] leading-snug " +
              (group.unreadCount > 0 ? "font-semibold" : "")
            }
            title={group.subject ?? undefined}
          >
            {rest.length > 0 ? rest : "(no subject)"}
          </span>
        </p>
        <p className="mt-1 truncate pl-5 text-[0.6875rem] text-[var(--muted)]">
          {participants.length > 0 ? participants : "Unknown participants"}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 pl-5 text-[0.6875rem] text-[var(--muted)]">
          <span className="font-mono tabular-nums">{formatDate(group.newestDateTime)}</span>
          {/*
            "in this folder", not "messages", and the qualifier is the whole
            point of the phrase.
            
            A conversation spans folders - one change-order thread routinely has
            messages in Inbox, a project folder, Sent Items and Drafts at the same
            time - and this pane is folder-scoped, so the count is the number of
            messages from this thread IN THIS FOLDER. Measured while scoping the
            phase: one ZZTEST thread returned 1 message folder-scoped and 4
            mailbox-wide (docs/06-roadmap.md). A bare "1 message" on that row
            would have been a false claim about the thread, which is the exact
            failure grouping-by-page was rejected for.

            Making it true across the mailbox needs a `conversationId eq` query
            per thread and a decision about Deleted Items, which Outlook hides
            from its conversation view and Graph does not. That is a bigger
            change than a label, and PHASE-9 scoped this to a folder - so the
            label tells the truth about what is being shown instead.
          */}
          <span>
            {group.messageCount} in this folder
            {group.unreadCount > 0 ? ` · ${group.unreadCount} unread` : ""}
          </span>
          {group.hasAttachments && <AttachmentGlyph />}
          {/*
            Stated on the collapsed row as well as shown beneath it. A draft
            inside a thread is the message somebody has to act on, and "there is
            a draft in here" has to survive the row being folded up.
          */}
          {group.draftCount > 0 && (
            <span
              className="shrink-0 rounded-[2px] px-1 py-px text-[0.5625rem] font-medium uppercase tracking-wide"
              style={{
                color: "var(--phb-orange-ink)",
                background: "color-mix(in srgb, var(--phb-orange) 20%, transparent)",
              }}
            >
              {group.draftCount === 1 ? "Draft" : `${group.draftCount} drafts`}
            </span>
          )}
          {/*
            What the collapsed row is holding back, said plainly - so the drafts
            listed underneath it are not mistaken for the whole thread.
          */}
          {!expanded && hiddenCount > 0 && (
            <span>
              {hiddenCount} hidden — expand
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

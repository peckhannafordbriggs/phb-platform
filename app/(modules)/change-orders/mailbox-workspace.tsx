"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageSummary } from "@/lib/modules/change-orders/mail/types";
import { FolderTree } from "./folder-tree";
import { MessageBodyFrame } from "./message-body";
import {
  ApiError,
  ancestorsOf,
  buildFolderTree,
  fetchFolders,
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
 * The read-only Change Orders mailbox.
 *
 * Read-only in the strict sense: every request this component can make is a GET,
 * and the service it reaches exposes no write method at all.
 *
 * Nothing here is persisted. The mailbox is read live from Exchange on demand,
 * which is why a stale list and a message that has moved are ordinary events
 * rather than errors - Power Automate moves messages constantly.
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

  const [searchInput, setSearchInput] = useState("");
  const [activeQuery, setActiveQuery] = useState("");

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

  // Open the tree far enough to reveal the selected folder - Drafts is a root,
  // but a project folder is three levels down.
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

  const selectFolder = useCallback((folder: FolderTreeNode) => {
    setSelectedFolder(folder);
    setSelectedId(null);
    setMessage(null);
    setMessageError(null);
    setVanished(false);
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
            placeholder="Search this folder"
            aria-label="Search this folder"
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
                  Search results, ordered by relevance rather than date.
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

      {/* Reading pane */}
      <div className="flex min-w-0 flex-1 flex-col bg-white">
        {vanished ? (
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
        ) : (
          <MessageView
            result={message}
            onShowImages={() => void openMessage(message.message.id, true)}
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
}: {
  result: MessageResult;
  onShowImages: () => void;
}) {
  const { message, attachments, remoteImagesAllowed } = result;

  return (
    <>
      <div className="shrink-0 border-b border-[var(--border)] px-6 py-4">
        <h2 className="text-base font-semibold" title={message.subject ?? undefined}>
          {message.subject ?? "(no subject)"}
        </h2>

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

        {attachments.length > 0 && (
          <div className="mt-3 border-t border-[var(--border)] pt-3">
            <p className="text-xs font-medium text-[var(--muted)]">
              {attachments.length === 1 ? "1 attachment" : `${attachments.length} attachments`}
            </p>
            <ul className="mt-1.5 flex flex-wrap gap-2">
              {attachments.map((a) => (
                <li
                  key={a.id}
                  className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
                  title={a.contentType ?? undefined}
                >
                  {a.name ?? "(unnamed)"}
                  <span className="ml-1.5 text-[var(--muted)]">{formatSize(a.sizeBytes)}</span>
                </li>
              ))}
            </ul>
            {/* Phase 5 reads names and sizes only. Downloading content is Phase 6. */}
            <p className="mt-1.5 text-xs italic text-[var(--muted)]">
              Open the message in Outlook to download an attachment.
            </p>
          </div>
        )}
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

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

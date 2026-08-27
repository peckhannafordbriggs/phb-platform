import type {
  AttachmentSummary,
  ConversationGroup,
  ConversationTruncation,
  MessageDetail,
  MessageSummary,
} from "@/lib/modules/change-orders/mail/types";

/**
 * The browser's view of the mail API.
 *
 * Every response is the platform's `{ data }` / `{ error: { code, message } }`
 * shape, so the components branch on a code the platform defined - never on an
 * HTTP status and never on anything from Graph.
 */

export interface FolderNode {
  id: string;
  displayName: string;
  parentFolderId: string | null;
  childFolderCount: number;
  totalItemCount: number;
  unreadItemCount: number;
  wellKnownName: string | null;
}

/**
 * What the mailbox was doing while a request appeared to hang.
 *
 * Set when Graph throttled at least one of the requests behind this response and
 * the middleware retried it. The wait is already over by the time the browser
 * sees this - it happened inside the one HTTP request - so this is what turns a
 * mysteriously slow pane into a stated reason after the fact.
 */
export interface RetryNotice {
  count: number;
  waitedSeconds: number;
}

export interface MessagePageResult {
  /** Which shape this is. The two are not interchangeable - see below. */
  grouped: boolean;
  /**
   * Present when `grouped`. Null otherwise.
   *
   * A grouped response has NO cursor: the service collected the folder to a cap
   * and grouped the complete set, because a conversation assembled from one page
   * renders a message count that is simply wrong. See listConversations.
   */
  conversations: ConversationGroup[] | null;
  /** Present when not `grouped`. Empty otherwise - read `conversations`. */
  messages: MessageSummary[];
  nextCursor: string | null;
  /**
   * There are matches or messages this response does not contain.
   *
   * A flat folder listing never sets it: it is paged, so a cursor means "there
   * is more", which is a different statement from "some was dropped". A search
   * and a grouped folder read are both capped, and both say so.
   */
  truncated: boolean;
  /**
   * Which cap, when truncated. The wording differs because the promises do:
   * `folder_cap` dropped the OLDEST messages, so a thread can be missing early
   * replies but never its newest; `search_cap` dropped an arbitrary subset,
   * because Exchange refuses to order a filtered collection at all.
   */
  truncation: ConversationTruncation | null;
  query: string;
  retry: RetryNotice | null;
}

export interface MessageResult {
  message: MessageDetail;
  attachments: AttachmentSummary[];
  remoteImagesAllowed: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Turns anything that is not an ApiError into something a person can see.
 *
 * Every catch in this module used to read `if (error instanceof ApiError)` and
 * do nothing otherwise, which meant a genuine bug in our own code - a TypeError,
 * a bad assumption - produced no message, no console entry, and no change on
 * screen. "I clicked it and nothing happened" was the only symptom available,
 * and it was reported exactly that way.
 *
 * A caught error is not re-thrown, deliberately: turning it into an unhandled
 * rejection would replace a silent failure with a dev-overlay crash over a
 * mailbox somebody is working in. It is surfaced and logged instead.
 */
export function describeUnexpected(error: unknown, what: string): string {
  // Aborts are navigation, not failure, and callers filter them before here.
  console.error(`[change-orders] ${what}`, error);

  return "Something went wrong. The details are in the browser console.";
}

/** True when the thing being asked for is gone - a normal event, not a failure. */
export function isMissing(error: unknown): boolean {
  return error instanceof ApiError && error.code === "not_found";
}

/**
 * The headers withMailbox sets when Graph throttled something behind this
 * response. Absent in the ordinary case, so presence is the signal.
 */
const RETRY_COUNT_HEADER = "x-phb-mail-retried";
const RETRY_WAIT_HEADER = "x-phb-mail-retry-wait";

function retryNoticeFrom(response: Response): RetryNotice | null {
  const count = Number.parseInt(response.headers.get(RETRY_COUNT_HEADER) ?? "", 10);
  if (!Number.isFinite(count) || count <= 0) return null;

  const waited = Number.parseInt(response.headers.get(RETRY_WAIT_HEADER) ?? "", 10);

  return { count, waitedSeconds: Number.isFinite(waited) ? waited : 0 };
}

/**
 * A GET that also returns the response, for the two callers that read a header
 * off it. Everything else uses `get` and never sees a Response.
 */
async function getWithResponse<T>(
  path: string,
  signal?: AbortSignal,
): Promise<{ data: T; response: Response }> {
  let response: Response;
  try {
    response = await fetch(path, { signal, cache: "no-store" });
  } catch (error) {
    // An aborted request is a navigation, not a failure worth showing.
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

  return { data: payload.data, response };
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return (await getWithResponse<T>(path, signal)).data;
}

const BASE = "/api/modules/change-orders";

export function fetchFolders(signal?: AbortSignal): Promise<{ folders: FolderNode[] }> {
  return get(`${BASE}/folders`, signal);
}

export async function fetchMessages(
  folderId: string,
  options: {
    cursor?: string | null;
    query?: string;
    top?: number;
    /** Grouped into conversations. Stated on every request, never inferred. */
    group?: boolean;
  },
  signal?: AbortSignal,
): Promise<MessagePageResult> {
  const params = new URLSearchParams();
  if (options.cursor != null && options.cursor.length > 0) {
    params.set("cursor", options.cursor);
  }
  if (options.query !== undefined && options.query.length > 0) {
    params.set("q", options.query);
  }
  // Paging options are meaningless to a grouped read, which has no cursor, so
  // they are not sent - an ignored parameter is a trap for whoever reads this
  // next.
  if (options.group === true) {
    params.set("group", "1");
  } else if (options.top !== undefined) {
    params.set("top", String(options.top));
  }

  const suffix = params.toString();
  const { data, response } = await getWithResponse<Omit<MessagePageResult, "retry">>(
    `${BASE}/folders/${encodeURIComponent(folderId)}/messages${suffix.length > 0 ? `?${suffix}` : ""}`,
    signal,
  );

  return {
    ...data,
    // Grouped responses carry no `messages`; normalising here keeps every
    // consumer from having to check which shape it received.
    messages: data.messages ?? [],
    retry: retryNoticeFrom(response),
  };
}

export function fetchMessage(
  messageId: string,
  options: { allowRemoteImages?: boolean } = {},
  signal?: AbortSignal,
): Promise<MessageResult> {
  const suffix = options.allowRemoteImages === true ? "?images=1" : "";
  return get(`${BASE}/messages/${encodeURIComponent(messageId)}${suffix}`, signal);
}

/**
 * Well-known folders first, in the order someone actually works through them,
 * then everything else alphabetically. Graph returns no useful ordering.
 */
const WELL_KNOWN_ORDER = ["inbox", "drafts", "sentitems", "deleteditems"];

export function sortFolders(folders: FolderNode[]): FolderNode[] {
  return [...folders].sort((a, b) => {
    const ai = a.wellKnownName === null ? -1 : WELL_KNOWN_ORDER.indexOf(a.wellKnownName);
    const bi = b.wellKnownName === null ? -1 : WELL_KNOWN_ORDER.indexOf(b.wellKnownName);

    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.displayName.localeCompare(b.displayName);
  });
}

export interface FolderTreeNode extends FolderNode {
  children: FolderTreeNode[];
  depth: number;
}

/**
 * Nests the flat list. A folder whose parent is not in the list is a root -
 * which is how the mailbox root's children arrive, since the root itself is
 * never returned.
 */
export function buildFolderTree(folders: FolderNode[]): FolderTreeNode[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const childrenOf = new Map<string | null, FolderNode[]>();

  for (const folder of folders) {
    const parent =
      folder.parentFolderId !== null && byId.has(folder.parentFolderId)
        ? folder.parentFolderId
        : null;
    const siblings = childrenOf.get(parent) ?? [];
    siblings.push(folder);
    childrenOf.set(parent, siblings);
  }

  const build = (parent: string | null, depth: number): FolderTreeNode[] =>
    sortFolders(childrenOf.get(parent) ?? []).map((folder) => ({
      ...folder,
      depth,
      children: build(folder.id, depth + 1),
    }));

  return build(null, 0);
}

/**
 * The folders the tree opens on first paint: the roots that have children.
 *
 * Not cosmetic. In this mailbox `Projects` is a child of Inbox, so a fully
 * collapsed tree shows 8 of 19 folders and no sign that a project hierarchy
 * exists - which reads as a truncated tree rather than a closed one.
 *
 * Roots only, deliberately. Opening every level would put all 19 on screen and
 * bury Drafts, which is the folder the default selection just chose.
 */
export function initiallyExpandedFolderIds(folders: FolderNode[]): string[] {
  return buildFolderTree(folders)
    .filter((node) => node.children.length > 0)
    .map((node) => node.id);
}

/** The ancestor ids of a folder, so the tree can open to reveal it. */
export function ancestorsOf(
  folders: FolderNode[],
  folderId: string,
): string[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: string[] = [];

  let current = byId.get(folderId)?.parentFolderId ?? null;
  while (current !== null && byId.has(current)) {
    path.push(current);
    current = byId.get(current)?.parentFolderId ?? null;
  }

  return path;
}

// ------------------------------------------------------------- conversations

/**
 * One rendered line in the grouped message pane.
 *
 * The list is derived rather than assembled inline in the component, because the
 * rule it enforces is worth a test rather than a code review: a collapsed group
 * still emits its drafts. Everything else about grouping is cosmetic; that part
 * is not, and it is the reason this function exists.
 */
export type ConversationRow =
  | {
      kind: "message";
      message: MessageSummary;
      /** A child of an expanded or collapsed group, rather than a lone message. */
      indented: boolean;
    }
  | {
      kind: "group";
      group: ConversationGroup;
      expanded: boolean;
      /**
       * Messages the collapsed row is not showing. Zero when expanded, and zero
       * when every message in the thread is a draft.
       *
       * Rendered on the row, so a collapsed group states what it is holding back
       * rather than implying the drafts under it are the whole thread.
       */
      hiddenCount: number;
    };

/**
 * A single-message conversation is an ordinary row, not a group of one.
 *
 * PHASE-9 asks for this explicitly, and it is most of what makes grouping worth
 * having in Drafts - a folder of unrelated one-message drafts should not turn
 * into a folder of collapsible groups each containing one thing.
 */
export function isSingleMessage(group: ConversationGroup): boolean {
  return group.messages.length === 1;
}

/**
 * Turns the grouped response into the rows to render.
 *
 * The one rule that is not cosmetic: **a collapsed group still emits its
 * drafts.** An unsent draft reply shares its conversation with the message it
 * answers, so grouping would otherwise fold the single most important message in
 * this mailbox behind a chevron - and reviewing drafts is the job the platform
 * exists to do.
 *
 * Order within a group is oldest first, which is how `ConversationGroup.messages`
 * already arrives: PHASE-9 asks for the individual messages "newest last".
 */
export function conversationRows(
  conversations: ConversationGroup[],
  expanded: ReadonlySet<string>,
): ConversationRow[] {
  const rows: ConversationRow[] = [];

  for (const group of conversations) {
    if (isSingleMessage(group)) {
      const only = group.messages[0];
      if (only !== undefined) rows.push({ kind: "message", message: only, indented: false });
      continue;
    }

    const isExpanded = expanded.has(group.id);
    const shown = isExpanded ? group.messages : group.messages.filter((m) => m.isDraft);

    rows.push({
      kind: "group",
      group,
      expanded: isExpanded,
      hiddenCount: group.messages.length - shown.length,
    });

    for (const message of shown) {
      rows.push({ kind: "message", message, indented: true });
    }
  }

  return rows;
}

/** The conversation a message is rendered under, so opening one can reveal it. */
export function conversationIdOf(
  conversations: ConversationGroup[],
  messageId: string,
): string | null {
  for (const group of conversations) {
    if (group.messages.some((m) => m.id === messageId)) return group.id;
  }
  return null;
}

/**
 * What a truncated listing may honestly claim.
 *
 * Two wordings, because there are two different promises and conflating them
 * would be the exact dishonesty this phase is about:
 *
 *   folder_cap - the collection was ordered newest-first by Exchange, so what
 *     did not fit is the OLDEST. A thread can be missing early replies. It
 *     cannot be missing its newest message, and the wording says so, because
 *     that is what tells the reader the row's date and subject are still right.
 *
 *   search_cap - Exchange refuses `$filter` with `$orderby`, so a search's
 *     result set has no order and what did not fit is an ARBITRARY subset. No
 *     such reassurance is available, and none is offered.
 *
 * Returns null when nothing was dropped. There is no "showing everything"
 * banner: a line that appears on every screen is a line nobody reads on the one
 * screen where it matters.
 */
export function truncationNotice(
  truncation: ConversationTruncation | null,
  shown: number,
): string | null {
  if (truncation === null) return null;

  if (truncation === "folder_cap") {
    return (
      `Grouped from the newest ${shown} messages in this folder — there are older ones. ` +
      `A conversation here may be missing its oldest messages, never its newest. ` +
      `Switch off grouping to page back through the whole folder.`
    );
  }

  return (
    `Grouped from the first ${shown} subject matches — there are more, and Exchange ` +
    `will not order a filtered search, so what is missing is not just the oldest. ` +
    `Narrow the search to be sure a conversation is complete.`
  );
}

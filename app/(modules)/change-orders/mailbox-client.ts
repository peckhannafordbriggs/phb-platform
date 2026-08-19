import type {
  AttachmentSummary,
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

export interface MessagePageResult {
  messages: MessageSummary[];
  nextCursor: string | null;
  ordered: boolean;
  query: string;
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

/** True when the thing being asked for is gone - a normal event, not a failure. */
export function isMissing(error: unknown): boolean {
  return error instanceof ApiError && error.code === "not_found";
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
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

  return payload.data;
}

const BASE = "/api/modules/change-orders";

export function fetchFolders(signal?: AbortSignal): Promise<{ folders: FolderNode[] }> {
  return get(`${BASE}/folders`, signal);
}

export function fetchMessages(
  folderId: string,
  options: { cursor?: string | null; query?: string; top?: number },
  signal?: AbortSignal,
): Promise<MessagePageResult> {
  const params = new URLSearchParams();
  if (options.cursor != null && options.cursor.length > 0) {
    params.set("cursor", options.cursor);
  }
  if (options.query !== undefined && options.query.length > 0) {
    params.set("q", options.query);
  }
  if (options.top !== undefined) params.set("top", String(options.top));

  const suffix = params.toString();
  return get(
    `${BASE}/folders/${encodeURIComponent(folderId)}/messages${suffix.length > 0 ? `?${suffix}` : ""}`,
    signal,
  );
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

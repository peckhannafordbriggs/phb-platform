import { ResponseType } from "@microsoft/microsoft-graph-client";
import type { Client, GraphRequest } from "@microsoft/microsoft-graph-client";
import type {
  Attachment,
  MailFolder,
  Message,
  Recipient,
} from "@microsoft/microsoft-graph-types";
import { logger } from "@/lib/logger";
import { readGraphEnv, readMailboxAddress } from "@/lib/env";
import { createGraphClient, graphClient, type GraphTransport } from "../graph/client";
import { mapGraphError } from "../graph/errors";
import { MailError } from "./errors";
import {
  assertSendAllowed,
  assertSendGateOpen,
  assertWriteAllowed,
} from "./guards";
import {
  applyBodyEdits,
  appendParagraph,
  extractBodySegments,
} from "./body-text";
import { sanitizeEmailHtml } from "./sanitize";
import {
  MAX_ATTACHMENT_BYTES,
  SIMPLE_UPLOAD_MAX_BYTES,
  UPLOAD_CHUNK_BYTES,
  assertUploadAllowed,
  safeAttachmentName,
  safeDownloadContentType,
} from "./attachments";
import type {
  AttachmentDownload,
  AttachmentSummary,
  AttachmentUpload,
  DeleteResult,
  DerivedDraftMode,
  MoveResult,
  NewDraftInput,
  DraftChanges,
  DraftForEdit,
  GetMessageOptions,
  ListMessagesOptions,
  MailAddress,
  MailFolderSummary,
  MailboxConnectionStatus,
  MessageDetail,
  MessagePage,
  MessageSummary,
} from "./types";

/**
 * The only thing in the codebase that talks to Microsoft Graph.
 *
 * Route handlers and components call methods here. They never construct a Graph
 * URL, never see a token, never see a Graph response shape, and never see an
 * HTTP status code from Graph. Every later phase adds methods to this class; if
 * a caller ever needs to know something about Graph to use it, the boundary has
 * leaked and the fix belongs in this file.
 *
 * Two rules this class enforces that no caller can opt out of:
 *
 *  1. Every request targets CO_MAILBOX. The address comes from configuration and
 *     is not a parameter on any method, so no caller can point this at another
 *     mailbox - including a caller written years from now.
 *  2. The development guards run here, not at the route layer. See ./guards.ts.
 */

/** Metadata only. `body` is deliberately absent - listing must not pull bodies. */
const MESSAGE_SUMMARY_SELECT = [
  "id",
  "conversationId",
  "subject",
  "from",
  "toRecipients",
  "receivedDateTime",
  "isDraft",
  "isRead",
  "hasAttachments",
].join(",");

const MESSAGE_DETAIL_SELECT = [
  MESSAGE_SUMMARY_SELECT,
  "ccRecipients",
  "bccRecipients",
  "replyTo",
  "sentDateTime",
  "parentFolderId",
  "body",
].join(",");

/**
 * `wellKnownName` is deliberately NOT selected. It exists on mailFolder in the
 * Graph BETA endpoint only; asking v1.0 for it fails the whole request with
 * `400 BadRequest: Could not find a property named 'wellKnownName'`. The
 * published @microsoft/microsoft-graph-types package not declaring it is the
 * tell. Identity comes from resolveWellKnownFolders() instead.
 */
const FOLDER_SELECT = [
  "id",
  "displayName",
  "parentFolderId",
  "childFolderCount",
  "unreadItemCount",
  "totalItemCount",
].join(",");

/**
 * Well-known folder aliases, usable directly in a path:
 * `/users/{mailbox}/mailFolders/drafts`. This is how v1.0 exposes the identity
 * of a special folder, and it is the only reliable way to find one.
 *
 * Matching on displayName is not an alternative: it is localised to the
 * mailbox's language, and a user can rename any folder in Outlook.
 *
 * Only the four the change-order workflow actually needs. Every alias added here
 * costs one request per listFolders().
 */
const WELL_KNOWN_FOLDER_ALIASES = [
  "inbox",
  "drafts",
  "sentitems",
  "deleteditems",
] as const;

/**
 * What the draft editor reads. `body` here is the raw stored body - the editor
 * writes it back, so it must not be the sanitized copy. `changeKey` is
 * Exchange's version marker, used to notice that Outlook edited the draft
 * underneath the editor.
 */
const DRAFT_EDIT_SELECT = [
  "id",
  "subject",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "body",
  "isDraft",
  "hasAttachments",
  "changeKey",
  "lastModifiedDateTime",
].join(",");

/**
 * `contentBytes` is NOT selected, and that is the point: GET /attachments
 * returns attachment content by default. Phase 4 does not download attachment
 * bytes, and nothing in this platform ever persists them.
 */
const ATTACHMENT_SELECT = ["id", "name", "contentType", "size", "isInline"].join(
  ",",
);

/**
 * The three Graph actions that produce a derived draft, keyed by the mode the
 * platform speaks.
 *
 * A lookup rather than string interpolation at the call site: it means a mode is
 * a member of a closed union, and no caller-supplied string can ever become a
 * path segment naming some other Graph action.
 */
const DERIVED_DRAFT_ACTIONS: Record<DerivedDraftMode, string> = {
  reply: "createReply",
  replyAll: "createReplyAll",
  forward: "createForward",
};

/**
 * Where a delete puts a message.
 *
 * A well-known folder name rather than an id, which `destinationId` accepts -
 * so no request is needed to resolve it, and it cannot go stale. See
 * deleteMessage() for why a delete is a move at all.
 */
const DELETED_ITEMS_FOLDER = "deleteditems";

/**
 * Search collects whole pages, because it has to sort the complete result set -
 * see searchMessages(). Bigger pages mean fewer requests for the same answer.
 */
const SEARCH_PAGE_SIZE = 100;

/**
 * The most matches a search will collect before saying it truncated.
 *
 * Generous relative to this mailbox, where the largest folder holds 13 messages,
 * so in practice a search is one request. It exists for the folder that has
 * grown to thousands by 2030, and it is reported rather than silent.
 */
const MAX_SEARCH_MATCHES = 500;

/** A second bound, on requests rather than results. Belt and braces. */
const MAX_SEARCH_PAGES = 5;

const DEFAULT_MESSAGE_PAGE_SIZE = 25;
const MAX_MESSAGE_PAGE_SIZE = 100;
const FOLDER_PAGE_SIZE = 100;

/** A mailbox with more top-level folder pages than this has bigger problems. */
const MAX_FOLDER_PAGES = 10;

/**
 * How deep the folder tree is walked.
 *
 * One level is not enough, which the real mailbox proves: `Projects` is a child
 * of Inbox, so the Projects tree the change-order process files into sits at
 * depth two. Stopping at one level returned the Projects folder but none of its
 * contents, which looked like an empty tree rather than a truncated walk.
 *
 * Bounded rather than unbounded: a folder loop would otherwise be an infinite
 * request loop, and depth is cheaper to cap than to detect.
 */
const MAX_FOLDER_DEPTH = 5;

/** Total folders returned, however deep. Truncation is always logged. */
const MAX_FOLDERS = 300;

interface GraphCollection<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

/**
 * An unbounded page size against one mailbox through one app identity is how
 * throttling starts, so a caller's `top` is clamped rather than trusted.
 */
function clampPageSize(requested: number | undefined): number {
  return Math.min(
    Math.max(requested ?? DEFAULT_MESSAGE_PAGE_SIZE, 1),
    MAX_MESSAGE_PAGE_SIZE,
  );
}

/**
 * Turns Graph's @odata.nextLink into an opaque cursor.
 *
 * Graph does not use one continuation mechanism. Mail collections page with
 * `$skip` - verified against the real mailbox, where a 13-message folder
 * requested with `$top=5` returns
 * `...&$top=5&$skip=5` - while other collections use `$skiptoken`. Reading only
 * for `$skiptoken` therefore looked like "there is no next page" on every mail
 * folder, and silently truncated every listing at one page.
 *
 * The cursor encodes which mechanism produced it so the caller keeps holding one
 * opaque string and no Graph URL crosses the boundary.
 */
function cursorFrom(nextLink: string | undefined): string | null {
  if (nextLink === undefined) return null;

  try {
    const params = new URL(nextLink).searchParams;

    const token = params.get("$skiptoken") ?? params.get("$skipToken");
    if (token !== null && token.length > 0) return `t:${token}`;

    const skip = params.get("$skip");
    if (skip !== null && /^\d+$/.test(skip)) return `s:${skip}`;

    return null;
  } catch {
    // A nextLink we cannot parse means we stop paginating rather than guess.
    logger.warn("mail.unparseable_next_link", { outcome: "pagination_stopped" });
    return null;
  }
}

/**
 * Applies a cursor that came back from cursorFrom.
 *
 * The value reaches here from a URL query parameter, so it is validated rather
 * than trusted: an unrecognised prefix or a non-numeric offset is ignored, which
 * returns the first page instead of letting a caller inject `$skip=-1`.
 */
function applyCursor(request: GraphRequest, cursor: string): GraphRequest {
  if (cursor.startsWith("t:")) {
    const token = cursor.slice(2);
    return token.length > 0 ? request.skipToken(token) : request;
  }

  if (cursor.startsWith("s:")) {
    const skip = Number.parseInt(cursor.slice(2), 10);
    return Number.isSafeInteger(skip) && skip > 0 ? request.skip(skip) : request;
  }

  return request;
}

/**
 * Control characters, built from escapes so none sits literally in this file.
 * They cannot appear in a subject anybody typed, and a CR or LF in a query
 * string is worth removing on principle.
 */
const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

/**
 * Escapes a value for an OData single-quoted string literal.
 *
 * A literal quote is doubled - that is OData's own escape, not a backslash. Get
 * this wrong and a subject containing an apostrophe ends the expression early:
 * searching for `P&G Reese's` would send `contains(subject,'P&G Reese's')`, and
 * Graph answers 400 on a query that looks completely ordinary. This mailbox has
 * a folder called `P&G Reese's`, so that is not hypothetical.
 *
 * Percent-encoding is the SDK's job and is not duplicated here.
 */
function escapeODataLiteral(value: string): string {
  return value.replace(CONTROL_CHARACTERS, "").replace(/'/g, "''");
}

function toAddress(recipient: Recipient | null | undefined): MailAddress | null {
  const address = recipient?.emailAddress?.address;
  if (address === undefined || address === null || address.length === 0) {
    return null;
  }
  return { name: recipient?.emailAddress?.name ?? null, address };
}

function toAddresses(
  recipients: Recipient[] | null | undefined,
): MailAddress[] {
  if (!Array.isArray(recipients)) return [];
  return recipients
    .map(toAddress)
    .filter((entry): entry is MailAddress => entry !== null);
}

/**
 * `wellKnownName` is filled in by the caller from resolveWellKnownFolders(),
 * because v1.0 will not return it - see FOLDER_SELECT.
 */
/**
 * Works out what the body should become, if anything.
 *
 * Order matters: text edits and a note are applied to the CURRENT body from
 * Exchange, not to anything the caller supplied, so a caller cannot smuggle in
 * a whole replacement body through the text-edit path.
 */
function resolveBodyChange(
  current: DraftForEdit,
  changes: DraftChanges,
): { content: string; format: "html" | "text" } | null {
  const hasEdits = changes.bodyEdits !== undefined && changes.bodyEdits.length > 0;
  const hasNote = changes.appendNote !== undefined && changes.appendNote.trim().length > 0;

  if (hasEdits || hasNote) {
    let content = current.body;
    if (hasEdits) {
      content = applyBodyEdits(content, current.segments, changes.bodyEdits ?? []);
    }
    if (hasNote) {
      content = appendParagraph(content, changes.appendNote ?? "");
    }

    // Unchanged after all that is not a write.
    return content === current.body ? null : { content, format: current.bodyFormat };
  }

  return changes.body ?? null;
}
/** The Graph shape for a recipient list, for writes. */
function toGraphRecipients(addresses: MailAddress[]): Recipient[] {
  return addresses.map((a) => ({
    emailAddress: { address: a.address, ...(a.name === null ? {} : { name: a.name }) },
  }));
}

function toFolderSummary(folder: MailFolder): MailFolderSummary {
  return {
    id: folder.id ?? "",
    displayName: folder.displayName ?? "",
    parentFolderId: folder.parentFolderId ?? null,
    totalItemCount: folder.totalItemCount ?? 0,
    unreadItemCount: folder.unreadItemCount ?? 0,
    childFolderCount: folder.childFolderCount ?? 0,
    wellKnownName: null,
  };
}

function toMessageSummary(message: Message): MessageSummary {
  return {
    id: message.id ?? "",
    conversationId: message.conversationId ?? null,
    subject: message.subject ?? null,
    from: toAddress(message.from),
    to: toAddresses(message.toRecipients),
    receivedDateTime: message.receivedDateTime ?? null,
    isDraft: message.isDraft ?? false,
    isRead: message.isRead ?? false,
    hasAttachments: message.hasAttachments ?? false,
  };
}

/**
 * Bytes as base64, for a simple attachment upload.
 *
 * Node's Buffer rather than a hand-rolled loop; this runs only in the Node
 * runtime, which every mail route declares.
 */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Newest first, the way every folder listing is ordered.
 *
 * A message with no usable `receivedDateTime` sorts last rather than first: an
 * unknown date must not be presented as the most recent thing in the mailbox.
 * An unparseable string is treated as absent for the same reason.
 */
function byNewestFirst(a: MessageSummary, b: MessageSummary): number {
  const at = timeOf(a.receivedDateTime);
  const bt = timeOf(b.receivedDateTime);

  if (at === null && bt === null) return 0;
  if (at === null) return 1;
  if (bt === null) return -1;

  return bt - at;
}

function timeOf(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function toAttachmentSummary(attachment: Attachment): AttachmentSummary {
  const odataType = (attachment as { "@odata.type"?: string })["@odata.type"];

  return {
    id: attachment.id ?? "",
    name: attachment.name ?? null,
    contentType: attachment.contentType ?? null,
    sizeBytes: attachment.size ?? null,
    isInline: attachment.isInline ?? false,
    isItemAttachment: odataType?.includes("itemAttachment") ?? false,
  };
}

export class ChangeOrderMailService {
  private readonly client: Client;
  private readonly mailbox: string;
  private readonly uploadFetch: typeof fetch;

  constructor(deps: {
    client: Client;
    mailbox: string;
    /**
     * Used for the PUT of each upload-session chunk, and nothing else.
     *
     * An upload session hands back a pre-authenticated `uploadUrl`, which is why
     * it cannot go through the Graph client: the client would attach a bearer
     * token, and Microsoft documents that the Authorization header must be
     * omitted on those PUTs. It is a constructor dependency rather than a bare
     * `fetch` call so a test can still intercept it, and so this file remains
     * the only place in the codebase that talks to Graph.
     */
    uploadFetch?: typeof fetch;
  }) {
    this.client = deps.client;
    this.mailbox = deps.mailbox;
    this.uploadFetch = deps.uploadFetch ?? globalThis.fetch;
  }

  /**
   * Every path in this class is built from here. There is no overload, no
   * optional argument and no setter that produces a different mailbox.
   */
  private path(suffix: string): string {
    return `/users/${encodeURIComponent(this.mailbox)}${suffix}`;
  }

  /**
   * Wraps a Graph call so that every failure leaving this class is a MailError.
   * A raw GraphError escaping to a caller would mean the boundary leaked.
   */
  private async call<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const mailError = mapGraphError(error, operation);
      logger.error("mail.graph_call_failed", {
        outcome: mailError.kind,
        reason: mailError.detail ?? undefined,
        route: operation,
      });
      throw mailError;
    }
  }

  /**
   * Well-known folders plus their immediate children, which is where the
   * Projects tree lives.
   *
   * Fetched as two steps rather than with $expand=childFolders so the shape does
   * not depend on Graph's expand support for this resource. The folder count in
   * this mailbox is small; this is a handful of requests, not a fan-out.
   */
  async listFolders(): Promise<MailFolderSummary[]> {
    const all: MailFolderSummary[] = await this.listFolderPage(
      this.path("/mailFolders"),
      "listFolders",
    );

    // Breadth-first, one round of requests per level. Each level's children are
    // fetched in parallel; the levels themselves are sequential, because the next
    // level's paths are not known until this one comes back.
    let frontier = all;
    for (let depth = 1; depth <= MAX_FOLDER_DEPTH; depth += 1) {
      const parents = frontier.filter(
        (folder) => folder.childFolderCount > 0 && folder.id.length > 0,
      );
      if (parents.length === 0) break;

      const levels = await Promise.all(
        parents.map((folder) =>
          this.listFolderPage(
            this.path(`/mailFolders/${encodeURIComponent(folder.id)}/childFolders`),
            "listFolders.children",
          ),
        ),
      );

      frontier = levels.flat();
      if (frontier.length === 0) break;

      all.push(...frontier);

      // Never truncate silently: if a cap is what stopped the walk, say which.
      if (all.length >= MAX_FOLDERS) {
        logger.warn("mail.folder_tree_capped", {
          outcome: "truncated",
          count: all.length,
          reason: `MAX_FOLDERS (${MAX_FOLDERS})`,
        });
        break;
      }
      if (depth === MAX_FOLDER_DEPTH && frontier.some((f) => f.childFolderCount > 0)) {
        logger.warn("mail.folder_tree_capped", {
          outcome: "truncated",
          count: all.length,
          reason: `MAX_FOLDER_DEPTH (${MAX_FOLDER_DEPTH})`,
        });
      }
    }

    const wellKnown = await this.resolveWellKnownFolders();

    return all.map((folder) => ({
      ...folder,
      wellKnownName: wellKnown.get(folder.id) ?? null,
    }));
  }

  /**
   * Maps folder id -> well-known alias, for the aliases that resolve.
   *
   * One request per alias, because v1.0 has no way to ask for this in bulk and
   * will not return `wellKnownName` on a listing. Four requests, in parallel,
   * only on a full folder listing.
   *
   * An alias that does not resolve is skipped rather than failing the listing: a
   * mailbox is not guaranteed to have every special folder, and a folder tree is
   * still worth returning without the labels. It is logged, not swallowed.
   */
  private async resolveWellKnownFolders(): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();

    const lookups = WELL_KNOWN_FOLDER_ALIASES.map(async (alias) => {
      try {
        const folder = await this.call(`resolveWellKnown.${alias}`, () =>
          this.client
            .api(this.path(`/mailFolders/${alias}`))
            // Only the id. The listing already has everything else.
            .select("id")
            .get() as Promise<MailFolder>,
        );
        return { alias, id: folder.id ?? null };
      } catch {
        // this.call already logged it with the operation name and request id.
        logger.warn("mail.well_known_folder_unresolved", {
          outcome: "skipped",
          reason: alias,
        });
        return { alias, id: null };
      }
    });

    for (const { alias, id } of await Promise.all(lookups)) {
      if (id !== null && id.length > 0) resolved.set(id, alias);
    }

    return resolved;
  }

  private async listFolderPage(
    path: string,
    operation: string,
  ): Promise<MailFolderSummary[]> {
    const folders: MailFolderSummary[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      // Captured before the closure so its type is not widened back to
      // `string | null` inside it.
      const token = cursor;

      const page: GraphCollection<MailFolder> = await this.call(
        operation,
        () => {
          let request = this.client
            .api(path)
            .select(FOLDER_SELECT)
            .top(FOLDER_PAGE_SIZE);
          if (token !== null) request = applyCursor(request, token);
          return request.get() as Promise<GraphCollection<MailFolder>>;
        },
      );

      folders.push(...(page.value ?? []).map(toFolderSummary));
      cursor = cursorFrom(page["@odata.nextLink"]);
      pages += 1;

      // Never truncate silently: if the cap is what stopped us, say so.
      if (cursor !== null && pages >= MAX_FOLDER_PAGES) {
        logger.warn("mail.folder_pages_capped", {
          outcome: "truncated",
          count: folders.length,
          route: operation,
        });
        break;
      }
    } while (cursor !== null);

    return folders;
  }

  /**
   * One folder, by id or by well-known alias - `getFolder("drafts")` works,
   * because an alias is a valid path segment in v1.0.
   *
   * `wellKnownName` comes back populated only when an alias was passed, since
   * that is the only case where it is known without four extra requests. A
   * caller that needs the labels for a whole tree uses listFolders().
   */
  async getFolder(folderId: string): Promise<MailFolderSummary> {
    const folder = await this.call("getFolder", () =>
      this.client
        .api(this.path(`/mailFolders/${encodeURIComponent(folderId)}`))
        .select(FOLDER_SELECT)
        .get() as Promise<MailFolder>,
    );

    const alias = WELL_KNOWN_FOLDER_ALIASES.find((a) => a === folderId) ?? null;

    return { ...toFolderSummary(folder), wellKnownName: alias };
  }

  /**
   * Metadata for one page of a folder, newest first.
   *
   * `cursor` is the opaque continuation from a previous page, not a Graph URL. `top` is
   * clamped: an unbounded page size against one mailbox through one app identity
   * is how throttling starts.
   */
  async listMessages(
    folderId: string,
    options: ListMessagesOptions = {},
  ): Promise<MessagePage> {
    const top = clampPageSize(options.top);

    const page = await this.call("listMessages", () => {
      let request = this.client
        .api(
          this.path(`/mailFolders/${encodeURIComponent(folderId)}/messages`),
        )
        .select(MESSAGE_SUMMARY_SELECT)
        .top(top);

      const cursor = options.cursor ?? "";
      if (cursor.length > 0) request = applyCursor(request, cursor);

      // $orderby has to be repeated on an offset page, and Graph's own nextLink
      // repeats it: `...&$orderby=receivedDateTime desc&$top=5&$skip=5`. An
      // offset into a differently ordered result set addresses different rows,
      // so dropping it here would make page two overlap page one and skip
      // messages entirely.
      //
      // A $skiptoken cursor is the opposite case - the token already encodes the
      // ordering, and Graph rejects the combination.
      if (!cursor.startsWith("t:")) {
        request = request.query({ $orderby: "receivedDateTime desc" });
      }

      return request.get() as Promise<GraphCollection<Message>>;
    });

    return {
      messages: (page.value ?? []).map(toMessageSummary),
      nextCursor: cursorFrom(page["@odata.nextLink"]),
      // A listing is paged, not capped: there is always a cursor when more
      // exists, so nothing is being withheld.
      truncated: false,
    };
  }

  /**
   * Searches one folder by subject, newest first.
   *
   * Two Graph limitations shape this whole method, both measured against the live
   * mailbox rather than assumed:
   *
   *   1. `$search` ignores `Prefer: IdType="ImmutableId"` - the header is on the
   *      request and Graph returns standard, folder-scoped ids anyway. Those die
   *      on the next move, and Power Automate moves messages constantly. So this
   *      filters instead of searching.
   *   2. `$filter` and `$orderby` cannot be combined on messages: Exchange
   *      answers `400 InefficientFilter`, for `contains` and `startswith` alike.
   *      So Graph will not order the result and the order it does return is
   *      neither date nor relevance - a real folder came back 08-19, 08-19,
   *      08-18, 08-25, 08-06.
   *
   * Which means the ordering has to happen here. It is done over the WHOLE result
   * set rather than per page, and that is the point: sorting each page
   * independently would produce a list that looks ordered and is not, because
   * page two can hold messages newer than the last row of page one. A subtly
   * wrong order is worse than an admittedly absent one.
   *
   * So this collects every match up to a cap, sorts, and returns the lot in one
   * response - `nextCursor` is always null for a search. In this mailbox that is
   * a single request: the largest folder holds 13 messages. It only becomes
   * several for folders that grow large, and it is bounded either way.
   *
   * Results are deduplicated by id while they accumulate. Paging with `$skip`
   * into a result set that has no guaranteed order can return the same row twice
   * if Exchange's order shifts between requests, and a duplicated row in a list
   * somebody is about to act on is not acceptable.
   *
   * `truncated` is returned rather than logged and forgotten: docs/07 and the
   * rest of this file treat silent truncation as a defect, and a search that
   * quietly stopped at 500 would look like a complete answer.
   *
   * The cost, stated plainly: this matches the SUBJECT ONLY - not the body, not
   * the sender, not attachment names. Accepted because subjects here carry the
   * bracketed project tag people actually search for, and because a stale id is a
   * correctness bug where a narrower search is a smaller feature.
   *
   * Matching is case-insensitive: `zztest` finds `ZZTEST`.
   */
  async searchMessages(folderId: string, query: string): Promise<MessagePage> {
    const term = query.trim();
    if (term.length === 0) {
      return { messages: [], nextCursor: null, truncated: false };
    }

    const filter = `contains(subject,'${escapeODataLiteral(term)}')`;
    const path = this.path(
      `/mailFolders/${encodeURIComponent(folderId)}/messages`,
    );

    const byId = new Map<string, MessageSummary>();
    let skip = 0;
    let pages = 0;
    let truncated = false;

    for (;;) {
      // Captured before the closure so its type is not widened inside it.
      const offset = skip;

      const page: GraphCollection<Message> = await this.call(
        "searchMessages",
        () => {
          let request = this.client
            .api(path)
            .select(MESSAGE_SUMMARY_SELECT)
            .filter(filter)
            .top(SEARCH_PAGE_SIZE);

          if (offset > 0) request = request.skip(offset);

          // No $orderby, deliberately. Exchange refuses $filter + $orderby with
          // 400 InefficientFilter, so adding one here does not degrade search -
          // it breaks every search outright. This is the line to check first if
          // search starts failing with "Something went wrong reaching the
          // mailbox" and the log shows code=InefficientFilter.
          return request.get() as Promise<GraphCollection<Message>>;
        },
      );

      const batch = page.value ?? [];
      for (const message of batch) {
        const summary = toMessageSummary(message);
        if (summary.id.length > 0) byId.set(summary.id, summary);
      }

      pages += 1;
      skip += batch.length;

      // Exchange had nothing more to give.
      if (batch.length === 0 || page["@odata.nextLink"] === undefined) break;

      if (byId.size >= MAX_SEARCH_MATCHES || pages >= MAX_SEARCH_PAGES) {
        truncated = true;
        logger.warn("mail.search_capped", {
          outcome: "truncated",
          count: byId.size,
          route: "searchMessages",
          reason:
            byId.size >= MAX_SEARCH_MATCHES
              ? `MAX_SEARCH_MATCHES (${MAX_SEARCH_MATCHES})`
              : `MAX_SEARCH_PAGES (${MAX_SEARCH_PAGES})`,
        });
        break;
      }
    }

    return {
      messages: [...byId.values()].sort(byNewestFirst),
      // Always null: every match this is willing to return is in `messages`.
      nextCursor: null,
      truncated,
    };
  }

  /**
   * One message, including its body.
   *
   * The HTML body is sanitized here rather than at the render site. A caller
   * cannot obtain the raw vendor markup through this service, because there is
   * no caller that has a legitimate use for it - see ./sanitize.ts.
   *
   * `allowRemoteImages` is the "show images" affordance, and it is off unless
   * asked for. Loading a remote image tells the sender the mail was opened, by
   * whom and when, so it is a decision a person makes per message rather than a
   * default.
   */
  async getMessage(
    messageId: string,
    options: GetMessageOptions = {},
  ): Promise<MessageDetail> {
    const message = await this.call("getMessage", () =>
      this.client
        .api(this.path(`/messages/${encodeURIComponent(messageId)}`))
        .select(MESSAGE_DETAIL_SELECT)
        .get() as Promise<Message>,
    );

    return {
      ...toMessageSummary(message),
      cc: toAddresses(message.ccRecipients),
      bcc: toAddresses(message.bccRecipients),
      replyTo: toAddresses(message.replyTo),
      sentDateTime: message.sentDateTime ?? null,
      parentFolderId: message.parentFolderId ?? null,
      body: this.toBody(message, options.allowRemoteImages ?? false),
    };
  }

  private toBody(
    message: Message,
    allowRemoteImages: boolean,
  ): MessageDetail["body"] {
    const content = message.body?.content;
    if (content === undefined || content === null) return null;

    if (message.body?.contentType === "html") {
      const sanitized = sanitizeEmailHtml(content, { allowRemoteImages });
      return {
        content: sanitized.html,
        format: "html",
        remoteImagesBlocked: sanitized.remoteImagesBlocked,
      };
    }

    return { content, format: "text", remoteImagesBlocked: 0 };
  }

  /**
   * Attachment metadata. Names, sizes, content types - no content.
   */
  async listAttachments(messageId: string): Promise<AttachmentSummary[]> {
    const page = await this.call("listAttachments", () =>
      this.client
        .api(
          this.path(`/messages/${encodeURIComponent(messageId)}/attachments`),
        )
        .select(ATTACHMENT_SELECT)
        .get() as Promise<GraphCollection<Attachment>>,
    );

    return (page.value ?? []).map(toAttachmentSummary);
  }

  /**
   * A draft, in the shape the editor needs.
   *
   * Refuses anything that is not a draft, in the service rather than the UI - a
   * sent message is immutable in Exchange and asking to edit one is a bug, not a
   * user error.
   *
   * Returns the RAW body. See DraftForEdit for why: saving the sanitized copy
   * back would overwrite the original with a lossy version every time anyone
   * touched a draft. The value only ever reaches a textarea.
   *
   * It also returns a sanitized `preview` of that same body. Both come from one
   * read, so the editable text and the rendered preview are always the same
   * version of the message.
   */
  async getDraftForEdit(
    messageId: string,
    options: GetMessageOptions = {},
  ): Promise<DraftForEdit> {
    const message = await this.call("getDraftForEdit", () =>
      this.client
        .api(this.path(`/messages/${encodeURIComponent(messageId)}`))
        .select(DRAFT_EDIT_SELECT)
        .get() as Promise<Message>,
    );

    if (message.isDraft !== true) {
      throw new MailError("not_draft", {
        detail: `getDraftForEdit refused: message ${messageId} is not a draft.`,
      });
    }

    const body = message.body?.content ?? "";
    const bodyFormat = message.body?.contentType === "html" ? "html" : "text";

    return {
      id: message.id ?? messageId,
      subject: message.subject ?? null,
      to: toAddresses(message.toRecipients),
      cc: toAddresses(message.ccRecipients),
      bcc: toAddresses(message.bccRecipients),
      body,
      bodyFormat,
      // Only HTML has markup worth protecting. A plain-text body is already
      // readable and is edited whole.
      segments: bodyFormat === "html" ? extractBodySegments(body) : [],
      preview: this.toBody(message, options.allowRemoteImages ?? false),
      hasAttachments: message.hasAttachments ?? false,
      changeKey: message.changeKey ?? null,
      lastModifiedDateTime: message.lastModifiedDateTime ?? null,
    };
  }

  /**
   * Saves an edit to a draft.
   *
   * The order of the checks is the safety model, and it is deliberate:
   *
   *   1. Read the current state from Exchange. Not from the caller - a caller
   *      that could supply the subject could supply "ZZTEST" and write anywhere.
   *   2. Refuse anything that is not a draft.
   *   3. Apply the ZZTEST fence, using that subject.
   *   4. Refuse if the draft changed since the editor last read it.
   *   5. Only then PATCH, and only the fields actually supplied.
   *
   * Attachments are never named in the payload, so Exchange leaves them alone.
   * The subject is written back byte for byte when supplied and omitted
   * entirely when not - nothing here parses, normalizes or regenerates the
   * `[CCHMC RFI 229]` tag that downstream filing depends on.
   */
  async updateDraft(
    messageId: string,
    changes: DraftChanges,
    options: GetMessageOptions = {},
  ): Promise<DraftForEdit> {
    const current = await this.getDraftForEdit(messageId);

    assertWriteAllowed(current.subject, "updateDraft");

    if (
      changes.expectedChangeKey !== undefined &&
      changes.expectedChangeKey !== null &&
      current.changeKey !== null &&
      changes.expectedChangeKey !== current.changeKey
    ) {
      throw new MailError("conflict", {
        detail:
          `updateDraft refused: draft ${messageId} changed in Exchange. ` +
          `Editor held a stale version.`,
      });
    }

    const payload: Record<string, unknown> = {};
    if (changes.subject !== undefined) payload.subject = changes.subject;
    if (changes.to !== undefined) payload.toRecipients = toGraphRecipients(changes.to);
    if (changes.cc !== undefined) payload.ccRecipients = toGraphRecipients(changes.cc);
    if (changes.bcc !== undefined) payload.bccRecipients = toGraphRecipients(changes.bcc);
    // Three ways the body can change, most-preserving first.
    //
    // Text edits and an appended note are splices into the body currently in
    // Exchange: every byte outside an edited run survives untouched, which is
    // what keeps the automation's table styling intact. Replacing the whole
    // body is the source escape hatch, and says so.
    const editedBody = resolveBodyChange(current, changes);
    if (editedBody !== null) {
      payload.body = {
        contentType: editedBody.format === "html" ? "HTML" : "Text",
        content: editedBody.content,
      };
    }

    // Nothing to do is not an error, and must not cost a write.
    if (Object.keys(payload).length === 0) return current;

    await this.call("updateDraft", () =>
      this.client
        .api(this.path(`/messages/${encodeURIComponent(messageId)}`))
        .patch(payload) as Promise<Message>,
    );

    // Re-read rather than trusting the PATCH response, so the caller gets the
    // changeKey Exchange actually settled on for the next save.
    return this.getDraftForEdit(messageId, options);
  }

  /**
   * Sends an existing draft.
   *
   * `POST /messages/{id}/send`, never `sendMail`. docs/03: sending a copied body
   * loses the attachments Power Automate attached, the subject tag downstream
   * filing depends on, and conversation threading.
   *
   * The send gate is checked before any network call, so a closed gate never
   * causes Exchange to be asked about a message that was never going to be sent.
   */
  async sendDraft(
    messageId: string,
    options: { expectedChangeKey?: string | null } = {},
  ): Promise<{ subject: string | null; to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[] }> {
    // Environment gate first: no Graph request at all when sending is off.
    assertSendGateOpen("sendDraft");

    const current = await this.getDraftForEdit(messageId);
    assertWriteAllowed(current.subject, "sendDraft");

    // The draft on the server must be the one the human read and approved. A
    // changed version means an autosave landed late or Outlook edited it, and
    // sending it would send content nobody reviewed.
    if (
      options.expectedChangeKey !== undefined &&
      options.expectedChangeKey !== null &&
      current.changeKey !== null &&
      options.expectedChangeKey !== current.changeKey
    ) {
      throw new MailError("conflict", {
        detail:
          `sendDraft refused: draft ${messageId} changed since it was reviewed. ` +
          `Sending would send content the sender did not see.`,
      });
    }

    await this.call("sendDraft", () =>
      this.client
        .api(this.path(`/messages/${encodeURIComponent(messageId)}/send`))
        // An empty body. Nothing about the message comes from the caller - that
        // is what makes this structurally incapable of becoming sendMail with a
        // copied body, which would drop the attachments Power Automate attached,
        // the subject tag downstream filing depends on, and the threading.
        .post({}) as Promise<unknown>,
    );

    // Returned so the caller can write the audit row describing what went. The
    // draft no longer exists, so this is the last moment these facts are
    // readable at all.
    return {
      subject: current.subject,
      to: current.to,
      cc: current.cc,
      bcc: current.bcc,
    };
  }

  // ------------------------------------------------------------------------
  // Phase 8: reply, reply-all, forward
  // ------------------------------------------------------------------------

  /**
   * Creates a reply draft, in Exchange, from Exchange's own operation.
   *
   * Why this is not string assembly, restated because it is the load-bearing
   * reason: `createReply` returns a real draft with the quoted original, the
   * `In-Reply-To` and `References` headers, and the same conversationId as the
   * message being replied to. Intake 6 matches replies by conversation ID, so a
   * reply assembled by concatenating bodies breaks the automation's filing -
   * silently, and nobody notices until a message does not get filed.
   *
   * The fence is applied to the SOURCE message's subject, read from Exchange.
   * That is the right thing to gate on: the question being asked is "may this
   * message be replied to", and the answer must not come from the caller.
   *
   * The draft this returns is opened in the Phase 6 editor. There is no separate
   * reply surface, no reply-specific autosave and no reply-specific send.
   */
  async createReplyDraft(messageId: string): Promise<DraftForEdit> {
    return this.createDerivedDraft(messageId, "reply");
  }

  /** Reply-all. Exchange decides the recipient list, from the original headers. */
  async createReplyAllDraft(messageId: string): Promise<DraftForEdit> {
    return this.createDerivedDraft(messageId, "replyAll");
  }

  /**
   * Forward.
   *
   * The original attachments come along, because `createForward` copies them -
   * that is Exchange's behaviour, not ours, and it is asserted against the live
   * mailbox rather than assumed. Nothing here enumerates or re-uploads them.
   */
  async createForwardDraft(messageId: string): Promise<DraftForEdit> {
    return this.createDerivedDraft(messageId, "forward");
  }

  /**
   * The one implementation behind the three above.
   *
   * `mode` is a closed union mapped to a fixed path here, so no caller-supplied
   * string ever reaches the URL - a mode that does not exist is a type error
   * rather than a request to an arbitrary Graph action.
   */
  private async createDerivedDraft(
    messageId: string,
    mode: DerivedDraftMode,
  ): Promise<DraftForEdit> {
    const action = DERIVED_DRAFT_ACTIONS[mode];

    // Read the source subject from Exchange and fence on it. A caller that could
    // supply the subject could supply "ZZTEST" and reply to anything.
    await this.assertWritable(messageId, `createDerivedDraft.${mode}`);

    const created = await this.call(`createDerivedDraft.${mode}`, () =>
      this.client
        .api(this.path(`/messages/${encodeURIComponent(messageId)}/${action}`))
        // An empty body deliberately. Passing `comment` or `message` here would
        // let a caller put content into a draft it never opened; the reviewer
        // types into the editor instead, through updateDraft, which is fenced.
        .post({}) as Promise<Message>,
    );

    const draftId = created.id ?? null;
    if (draftId === null || draftId.length === 0) {
      throw new MailError("unexpected", {
        detail: `${action} returned no message id for source ${messageId}.`,
      });
    }

    // Re-read rather than trusting the create response: the editor needs the
    // full DRAFT_EDIT_SELECT shape, the segments computed from the stored body,
    // and the changeKey Exchange actually settled on.
    return this.getDraftForEdit(draftId);
  }

  // ------------------------------------------------------------------------
  // Phase 8: compose from scratch
  // ------------------------------------------------------------------------

  /**
   * Creates an empty draft, which then opens in the Phase 6 editor.
   *
   * The ZZTEST fence is applied to the subject the caller supplied, and this is
   * the one place in the service where that is the case. It is not a hole in the
   * rule, it is the rule reaching its limit: the message does not exist yet, so
   * Exchange has no subject to read. What the rule protects against - a caller
   * naming a subject in order to write to a message it is not allowed to touch -
   * cannot happen here, because the only message this can affect is the empty one
   * it is about to create.
   *
   * It is then verified the other way round: after the create, the subject is
   * read back FROM EXCHANGE and the fence applied again. From that point on every
   * operation on the draft - edit, attach, send - is fenced on Exchange's copy
   * like everything else.
   *
   * The body is written as explicitly-empty HTML rather than omitted, so the
   * editor gets a deterministic bodyFormat instead of whatever Graph defaults to.
   * An empty body has no text segments to splice, which is the case the editor's
   * "add a paragraph" affordance exists for.
   */
  async createDraft(input: NewDraftInput = {}): Promise<DraftForEdit> {
    const subject = input.subject ?? "";
    assertWriteAllowed(subject, "createDraft");

    const payload: Record<string, unknown> = {
      subject,
      body: {
        contentType: input.body?.format === "text" ? "Text" : "HTML",
        content: input.body?.content ?? "",
      },
    };
    if (input.to !== undefined) payload.toRecipients = toGraphRecipients(input.to);
    if (input.cc !== undefined) payload.ccRecipients = toGraphRecipients(input.cc);
    if (input.bcc !== undefined) payload.bccRecipients = toGraphRecipients(input.bcc);

    const created = await this.call("createDraft", () =>
      this.client.api(this.path("/messages")).post(payload) as Promise<Message>,
    );

    const draftId = created.id ?? null;
    if (draftId === null || draftId.length === 0) {
      throw new MailError("unexpected", {
        detail: "createDraft returned no message id.",
      });
    }

    const draft = await this.getDraftForEdit(draftId);

    // The fence, now on Exchange's own copy. Belt and braces rather than
    // theatre: if Exchange ever normalised the subject into something outside
    // the fence, every later operation on this draft would be refused, and it is
    // better to find that out here than at the moment somebody tries to send.
    assertWriteAllowed(draft.subject, "createDraft.verify");

    return draft;
  }

  // ------------------------------------------------------------------------
  // Phase 8: move and delete
  // ------------------------------------------------------------------------

  /**
   * Moves a message to another folder.
   *
   * The ID question, verified rather than trusted: Exchange assigns a moved
   * message a NEW id unless immutable IDs are in use. They are - the middleware
   * sets `Prefer: IdType="ImmutableId"` on every request without exception - so
   * the id should survive the move. This returns both ids and whether they
   * differed, so a regression in that header shows up as data rather than as a
   * message that mysteriously cannot be found afterwards.
   *
   * `destinationId` is the only thing taken from the caller, and it is an opaque
   * folder id. A folder that was renamed or deleted in Outlook comes back from
   * Graph as a not-found, which is an ordinary event here, not a fault.
   */
  async moveMessage(
    messageId: string,
    destinationFolderId: string,
  ): Promise<MoveResult> {
    const subject = await this.subjectOf(messageId);
    assertWriteAllowed(subject, "moveMessage");

    if (destinationFolderId.trim().length === 0) {
      throw new MailError("not_found", {
        detail: "moveMessage refused: no destination folder id.",
      });
    }

    const moved = await this.call("moveMessage", () =>
      this.client
        .api(this.path(`/messages/${encodeURIComponent(messageId)}/move`))
        .post({ destinationId: destinationFolderId }) as Promise<Message>,
    );

    const id = moved.id ?? messageId;
    const idChanged = id !== messageId;

    if (idChanged) {
      /**
       * Not thrown: the move succeeded and the caller is handed the id the
       * message has now, so the operation is fine.
       *
       * The likely cause is NOT that immutable ids stopped working. Verified
       * against the live mailbox: `$search` does not honour
       * `Prefer: IdType="ImmutableId"` even though the header is on the request,
       * so any id that came from the search box is a standard, folder-scoped id -
       * and a standard id is exactly the kind that changes on a move. An id from
       * a folder LISTING is immutable and survives.
       *
       * The earlier version of this log line asserted the header had stopped
       * taking effect, which is the wrong first place to look and cost an
       * afternoon. Both possibilities are named now, likeliest first.
       */
      logger.warn("mail.move_changed_id", {
        outcome: "id_changed",
        reason:
          "the id supplied was probably not an immutable id (ids from $search " +
          "are not); failing that, the ImmutableId header has stopped working",
        route: "moveMessage",
      });
    }

    return {
      id,
      previousId: messageId,
      idChanged,
      destinationFolderId,
      subject,
    };
  }

  /**
   * Deletes a message, by MOVING it to Deleted Items.
   *
   * A move, not `DELETE`, and this is a correction the live mailbox forced.
   *
   * docs/03 and PHASE-8 both said `DELETE /messages/{id}` "moves the message to
   * Deleted Items". Against `changeorder@phb1899.com` it does not: the message
   * lands in **Recoverable Items \ Deletions** - the dumpster - and the
   * user-visible Deleted Items folder never sees it. Verified twice, on a draft
   * and on a received message, by reading `parentFolderId` afterwards and
   * resolving that folder: "Deletions", 209 items, while Deleted Items held 4.
   *
   * Why that difference matters enough to change the implementation rather than
   * the wording. An item in Deleted Items is recovered by opening the folder and
   * dragging it back - something the operator can do without being told how. An
   * item in Recoverable Items needs Outlook's "Recover Deleted Items from
   * Server" dialog, which nobody finds under pressure, and which is subject to
   * the deleted-item retention window. The confirmation dialog promises the
   * former. Making the code match the promise is the honest fix; softening the
   * promise to match the code would have made a recoverable action feel
   * unrecoverable, and this mailbox runs a daily process.
   *
   * `destinationId` takes a well-known folder name as well as an id, so this
   * needs no extra request to resolve the folder first.
   *
   * There is deliberately no counterpart for `permanentDelete`. Not behind a
   * flag, not behind a confirmation, not in an admin screen: CLAUDE.md and
   * docs/03 both forbid it, it destroys the audit trail, and there is no
   * legitimate need for it in a change-order mailbox. Note that this change
   * moves the platform FURTHER from permanent deletion, not closer.
   */
  async deleteMessage(messageId: string): Promise<DeleteResult> {
    const subject = await this.subjectOf(messageId);
    assertWriteAllowed(subject, "deleteMessage");

    const moved = await this.call("deleteMessage", () =>
      this.client
        .api(this.path(`/messages/${encodeURIComponent(messageId)}/move`))
        .post({ destinationId: DELETED_ITEMS_FOLDER }) as Promise<Message>,
    );

    // Returned so the caller can write an audit row describing what went. The id
    // is returned too: it should be unchanged, and a caller that wants to offer
    // an undo needs the id the message has now.
    return { subject, id: moved.id ?? messageId };
  }

  // ------------------------------------------------------------------------
  // Phase 8: attachments
  // ------------------------------------------------------------------------

  /**
   * One attachment's bytes, for streaming straight back to the browser.
   *
   * Nothing is written to disk and nothing is cached. The bytes exist for the
   * length of one response and are then dropped - docs/03, "never persist
   * attachment content", which includes not persisting it briefly.
   *
   * Metadata first, then content, for three reasons: the size is checked before
   * anything large is pulled into memory, the name and content type come from
   * Exchange rather than from the caller, and an attachment that is not there is
   * a cheap not-found rather than a failed download.
   */
  async downloadAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<AttachmentDownload> {
    const meta = await this.call("downloadAttachment.meta", () =>
      this.client
        .api(
          this.path(
            `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
          ),
        )
        .select(ATTACHMENT_SELECT)
        .get() as Promise<Attachment>,
    );

    const summary = toAttachmentSummary(meta);

    if ((summary.sizeBytes ?? 0) > MAX_ATTACHMENT_BYTES) {
      throw new MailError("attachment_too_large", {
        detail:
          `Refused download of ${summary.sizeBytes} bytes from message ` +
          `${messageId}: over the ${MAX_ATTACHMENT_BYTES}-byte limit.`,
      });
    }

    /**
     * `/$value` rather than reading `contentBytes` off the resource.
     *
     * Two reasons. `contentBytes` is base64, so it costs a third more memory and
     * a decode for every download. And selecting it means the metadata read and
     * the content read are the same request, which would pull whole attachments
     * into memory just to answer "how big is it".
     *
     * An itemAttachment - a message forwarded as an attachment - answers with the
     * MIME of that message, which is a valid .eml file. Both cases work.
     */
    const buffer = (await this.call("downloadAttachment.content", () =>
      this.client
        .api(
          this.path(
            `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
          ),
        )
        .responseType(ResponseType.ARRAYBUFFER)
        .get() as Promise<ArrayBuffer>,
    )) as ArrayBuffer;

    const name = safeAttachmentName(summary.name);

    return {
      // An item attachment is a message, not a file, and Exchange gives it no
      // extension of its own. Saving it as .eml is what makes it openable.
      name: summary.isItemAttachment && !name.toLowerCase().endsWith(".eml")
        ? `${name}.eml`
        : name,
      contentType: summary.isItemAttachment
        ? "message/rfc822"
        : safeDownloadContentType(summary.contentType),
      bytes: new Uint8Array(buffer),
    };
  }

  /**
   * Adds one attachment to a draft.
   *
   * Only to a draft: `getDraftForEdit` refuses anything that is not one, and a
   * sent message is immutable in Exchange regardless. The fence runs on the
   * subject that read returned.
   *
   * The existing attachments are never named in the request. That is what keeps
   * them: a draft the automation created already carries attachments downstream
   * flows expect, and this adds a sibling rather than replacing a set.
   *
   * Under 3 MB is a simple POST; at or above it Graph requires an upload session.
   * docs/03 fixes that boundary, and `assertUploadAllowed` fixes the ceiling.
   */
  async addDraftAttachment(
    messageId: string,
    upload: AttachmentUpload,
  ): Promise<AttachmentSummary[]> {
    const draft = await this.getDraftForEdit(messageId);
    assertWriteAllowed(draft.subject, "addDraftAttachment");

    const { name, contentType } = assertUploadAllowed({
      name: upload.name,
      contentType: upload.contentType,
      sizeBytes: upload.bytes.byteLength,
    });

    if (upload.bytes.byteLength < SIMPLE_UPLOAD_MAX_BYTES) {
      await this.call("addDraftAttachment.simple", () =>
        this.client
          .api(this.path(`/messages/${encodeURIComponent(messageId)}/attachments`))
          .post({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name,
            contentType,
            contentBytes: toBase64(upload.bytes),
          }) as Promise<Attachment>,
      );
    } else {
      await this.uploadLargeAttachment(messageId, { ...upload, name, contentType });
    }

    // Re-read rather than reporting what we sent. This is the assertion that the
    // pre-existing attachments survived, and the caller shows the list it
    // returns - so "the other one is gone" is visible immediately rather than at
    // send time.
    return this.listAttachments(messageId);
  }

  /**
   * An attachment at or above 3 MB, through an upload session.
   *
   * The session hands back a pre-authenticated `uploadUrl`, and each chunk is
   * PUT to it WITHOUT an Authorization header - Microsoft documents that
   * explicitly, and sending one can fail the upload. That is why these PUTs do
   * not go through the Graph client, and why `uploadFetch` is a constructor
   * dependency rather than a bare global call.
   *
   * Chunks are sequential, not parallel. Graph requires the ranges to arrive in
   * order, and parallel PUTs against one mailbox through one app identity is how
   * throttling starts.
   */
  private async uploadLargeAttachment(
    messageId: string,
    upload: AttachmentUpload,
  ): Promise<void> {
    const total = upload.bytes.byteLength;

    const session = await this.call("addDraftAttachment.createUploadSession", () =>
      this.client
        .api(
          this.path(
            `/messages/${encodeURIComponent(messageId)}/attachments/createUploadSession`,
          ),
        )
        .post({
          AttachmentItem: {
            attachmentType: "file",
            name: upload.name,
            size: total,
            contentType: upload.contentType,
          },
        }) as Promise<{ uploadUrl?: string }>,
    );

    const uploadUrl = session.uploadUrl ?? "";
    if (uploadUrl.length === 0) {
      throw new MailError("unexpected", {
        detail: "createUploadSession returned no uploadUrl.",
      });
    }

    for (let offset = 0; offset < total; offset += UPLOAD_CHUNK_BYTES) {
      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, total) - 1;
      const chunk = upload.bytes.subarray(offset, end + 1);

      let response: Response;
      try {
        response = await this.uploadFetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Length": String(chunk.byteLength),
            "Content-Range": `bytes ${offset}-${end}/${total}`,
          },
          // A copy, so the request body cannot be a view over a buffer something
          // else still holds.
          body: new Uint8Array(chunk).buffer as ArrayBuffer,
        });
      } catch (error) {
        throw new MailError("network", {
          detail: `Attachment upload chunk ${offset}-${end}/${total} never got an answer.`,
          cause: error,
        });
      }

      if (response.status === 429 || response.status === 503) {
        // Deliberately not retried here. The Graph client retries a throttled
        // request once; an upload session cannot be resumed by replaying a chunk
        // blindly, and a half-uploaded attachment that looks complete is worse
        // than one the person is asked to add again.
        throw new MailError("throttled", {
          detail: `Attachment upload throttled at ${offset}-${end}/${total}.`,
        });
      }

      if (!response.ok) {
        throw new MailError("unexpected", {
          detail:
            `Attachment upload chunk ${offset}-${end}/${total} answered ` +
            `${response.status}.`,
        });
      }
    }
  }

  /**
   * Removes one attachment from a draft.
   *
   * Draft only, and that is a refusal rather than a UI convenience: a sent or
   * received message is immutable in Exchange, and removing an attachment from
   * the record of what was actually sent would be falsifying it.
   *
   * Removing one attachment the automation attached is a legitimate human
   * decision. Disturbing the others is not, so this names exactly one id and the
   * refreshed list it returns is the proof.
   */
  async removeDraftAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<AttachmentSummary[]> {
    let draft: DraftForEdit;
    try {
      draft = await this.getDraftForEdit(messageId);
    } catch (error) {
      if (error instanceof MailError && error.kind === "not_draft") {
        throw new MailError("not_permitted", {
          detail:
            `removeDraftAttachment refused: message ${messageId} has already ` +
            `been sent or received, so its attachments are part of the record.`,
        });
      }
      throw error;
    }

    assertWriteAllowed(draft.subject, "removeDraftAttachment");

    await this.call("removeDraftAttachment", () =>
      this.client
        .api(
          this.path(
            `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
          ),
        )
        .delete() as Promise<unknown>,
    );

    return this.listAttachments(messageId);
  }

  /**
   * The write gate, on its own, for an operation that has no other reason to
   * read the message first.
   *
   * It reads the subject from Exchange rather than taking it from the caller, so
   * the ZZTEST fence is decided by what is actually in the mailbox. A caller that
   * could pass its own subject could pass "ZZTEST" and write anywhere.
   *
   * Phase 8's move and delete use it directly; the draft operations get the same
   * check for free, because they have already read the draft.
   */
  async assertWritable(messageId: string, operation: string): Promise<void> {
    assertWriteAllowed(await this.subjectOf(messageId), operation);
  }

  /**
   * The send gate. Same reasoning, plus PHB_ALLOW_SEND.
   *
   * CLAUDE.md prohibition 1: nothing in this system sends automatically. A send
   * is always a human clicking send on an existing draft, and it always goes
   * through here first.
   */
  async assertSendable(messageId: string, operation: string): Promise<void> {
    assertSendAllowed(await this.subjectOf(messageId), operation);
  }

  private async subjectOf(messageId: string): Promise<string | null> {
    const message = await this.call("subjectOf", () =>
      this.client
        .api(this.path(`/messages/${encodeURIComponent(messageId)}`))
        .select("id,subject")
        .get() as Promise<Message>,
    );

    return message.subject ?? null;
  }
}

/**
 * Builds a service.
 *
 * `transport` exists so tests can intercept at the HTTP layer and exercise the
 * real client, the real middleware chain and the real error mapping. It cannot
 * supply a mailbox: that always comes from CO_MAILBOX.
 */
export function createMailService(
  transport?: GraphTransport,
): ChangeOrderMailService {
  const mailbox = readMailboxAddress();
  if (mailbox === null) {
    throw new MailError("not_configured", {
      detail: "CO_MAILBOX is missing or is not a valid email address.",
    });
  }

  return new ChangeOrderMailService({
    client: transport === undefined ? graphClient() : createGraphClient(transport),
    mailbox,
    // An upload-session PUT does not go through the Graph client - see the
    // constructor - so a test that intercepts the transport has to intercept
    // this too, or the one request that leaves the process is the real one.
    uploadFetch: transport?.fetchImpl,
  });
}

let memoisedService: ChangeOrderMailService | null = null;

/** The process-wide service. Memoised so the token cache behind it persists. */
export function mailService(): ChangeOrderMailService {
  if (memoisedService === null) memoisedService = createMailService();
  return memoisedService;
}

/**
 * Whether a Graph credential is configured, without attempting a call.
 *
 * Callers check this instead of catching not_configured, so "IT has not created
 * the app registration yet" is a reported state rather than an error path.
 */
export function mailboxConnectionStatus(): MailboxConnectionStatus {
  const graphEnv = readGraphEnv();

  if (!graphEnv.present) {
    return { configured: false, missing: graphEnv.missing };
  }

  return { configured: true, mailbox: graphEnv.values.CO_MAILBOX };
}

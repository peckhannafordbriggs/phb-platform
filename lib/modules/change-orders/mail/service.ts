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
import { assertSendAllowed, assertWriteAllowed } from "./guards";
import { sanitizeEmailHtml } from "./sanitize";
import type {
  AttachmentSummary,
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
 * `contentBytes` is NOT selected, and that is the point: GET /attachments
 * returns attachment content by default. Phase 4 does not download attachment
 * bytes, and nothing in this platform ever persists them.
 */
const ATTACHMENT_SELECT = ["id", "name", "contentType", "size", "isInline"].join(
  ",",
);

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

  constructor(deps: { client: Client; mailbox: string }) {
    this.client = deps.client;
    this.mailbox = deps.mailbox;
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
    };
  }

  /**
   * Searches one folder.
   *
   * `$search` is not `$filter`. Graph rejects it combined with `$orderby`, and
   * results come back by relevance rather than by date - so this returns no
   * ordering guarantee and the UI must not imply one.
   *
   * The term is quoted and its quotes escaped. Without that, a subject
   * containing a double quote ends the search expression early and Graph
   * answers 400 on an ordinary-looking query.
   */
  async searchMessages(
    folderId: string,
    query: string,
    options: ListMessagesOptions = {},
  ): Promise<MessagePage> {
    const term = query.trim();
    if (term.length === 0) return { messages: [], nextCursor: null };

    const top = clampPageSize(options.top);
    const escaped = term.replace(/"/g, '\\"');

    const page = await this.call("searchMessages", () => {
      let request = this.client
        .api(this.path(`/mailFolders/${encodeURIComponent(folderId)}/messages`))
        .select(MESSAGE_SUMMARY_SELECT)
        .search(`"${escaped}"`)
        .top(top);

      if (options.cursor !== undefined && options.cursor.length > 0) {
        request = applyCursor(request, options.cursor);
      }

      return request.get() as Promise<GraphCollection<Message>>;
    });

    return {
      messages: (page.value ?? []).map(toMessageSummary),
      nextCursor: cursorFrom(page["@odata.nextLink"]),
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
   * The write gate, ready for the phase that adds writes.
   *
   * It reads the subject from Exchange rather than taking it from the caller, so
   * the ZZTEST fence is decided by what is actually in the mailbox. A caller that
   * could pass its own subject could pass "ZZTEST" and write anywhere.
   *
   * Phase 4 implements no write operation. This exists so that when one is added
   * it is added to something already correct.
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

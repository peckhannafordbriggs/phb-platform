import type { Client } from "@microsoft/microsoft-graph-client";
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

const FOLDER_SELECT = [
  "id",
  "displayName",
  "parentFolderId",
  "childFolderCount",
  "unreadItemCount",
  "totalItemCount",
  "wellKnownName",
].join(",");

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

interface GraphCollection<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

/**
 * Graph paginates with an opaque nextLink URL. Callers get the token out of it
 * and nothing else, so no Graph URL crosses the boundary.
 */
function skipTokenFrom(nextLink: string | undefined): string | null {
  if (nextLink === undefined) return null;

  try {
    const params = new URL(nextLink).searchParams;
    return params.get("$skiptoken") ?? params.get("$skipToken");
  } catch {
    // A nextLink we cannot parse means we stop paginating rather than guess.
    logger.warn("mail.unparseable_next_link", { outcome: "pagination_stopped" });
    return null;
  }
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

function toFolderSummary(folder: MailFolder): MailFolderSummary {
  // wellKnownName is returned by Graph v1.0 but is missing from the published
  // types, so it is read explicitly rather than through the type.
  const wellKnownName = (folder as { wellKnownName?: string | null })
    .wellKnownName;

  return {
    id: folder.id ?? "",
    displayName: folder.displayName ?? "",
    parentFolderId: folder.parentFolderId ?? null,
    totalItemCount: folder.totalItemCount ?? 0,
    unreadItemCount: folder.unreadItemCount ?? 0,
    childFolderCount: folder.childFolderCount ?? 0,
    wellKnownName: wellKnownName ?? null,
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
    const top = await this.listFolderPage(this.path("/mailFolders"), "listFolders");

    const children = await Promise.all(
      top
        .filter((folder) => folder.childFolderCount > 0 && folder.id.length > 0)
        .map((folder) =>
          this.listFolderPage(
            this.path(`/mailFolders/${encodeURIComponent(folder.id)}/childFolders`),
            "listFolders.children",
          ),
        ),
    );

    return [...top, ...children.flat()];
  }

  private async listFolderPage(
    path: string,
    operation: string,
  ): Promise<MailFolderSummary[]> {
    const folders: MailFolderSummary[] = [];
    let skipToken: string | null = null;
    let pages = 0;

    do {
      // Captured before the closure so its type is not widened back to
      // `string | null` inside it.
      const token = skipToken;

      const page: GraphCollection<MailFolder> = await this.call(
        operation,
        () => {
          let request = this.client
            .api(path)
            .select(FOLDER_SELECT)
            .top(FOLDER_PAGE_SIZE);
          if (token !== null) request = request.skipToken(token);
          return request.get() as Promise<GraphCollection<MailFolder>>;
        },
      );

      folders.push(...(page.value ?? []).map(toFolderSummary));
      skipToken = skipTokenFrom(page["@odata.nextLink"]);
      pages += 1;

      // Never truncate silently: if the cap is what stopped us, say so.
      if (skipToken !== null && pages >= MAX_FOLDER_PAGES) {
        logger.warn("mail.folder_pages_capped", {
          outcome: "truncated",
          count: folders.length,
          route: operation,
        });
        break;
      }
    } while (skipToken !== null);

    return folders;
  }

  async getFolder(folderId: string): Promise<MailFolderSummary> {
    const folder = await this.call("getFolder", () =>
      this.client
        .api(this.path(`/mailFolders/${encodeURIComponent(folderId)}`))
        .select(FOLDER_SELECT)
        .get() as Promise<MailFolder>,
    );

    return toFolderSummary(folder);
  }

  /**
   * Metadata for one page of a folder, newest first.
   *
   * `skipToken` is the token from a previous page, not a Graph URL. `top` is
   * clamped: an unbounded page size against one mailbox through one app identity
   * is how throttling starts.
   */
  async listMessages(
    folderId: string,
    options: ListMessagesOptions = {},
  ): Promise<MessagePage> {
    const top = Math.min(
      Math.max(options.top ?? DEFAULT_MESSAGE_PAGE_SIZE, 1),
      MAX_MESSAGE_PAGE_SIZE,
    );

    const page = await this.call("listMessages", () => {
      let request = this.client
        .api(
          this.path(`/mailFolders/${encodeURIComponent(folderId)}/messages`),
        )
        .select(MESSAGE_SUMMARY_SELECT)
        .top(top);

      if (options.skipToken !== undefined && options.skipToken.length > 0) {
        request = request.skipToken(options.skipToken);
      } else {
        // Graph rejects $orderby combined with a skip token on this collection,
        // and the token already encodes the order of the first page.
        request = request.query({ $orderby: "receivedDateTime desc" });
      }

      return request.get() as Promise<GraphCollection<Message>>;
    });

    return {
      messages: (page.value ?? []).map(toMessageSummary),
      nextSkipToken: skipTokenFrom(page["@odata.nextLink"]),
    };
  }

  /**
   * One message, including its body.
   *
   * The HTML body is sanitized here rather than at the render site. A caller
   * cannot obtain the raw vendor markup through this service, because there is
   * no caller that has a legitimate use for it - see ./sanitize.ts.
   */
  async getMessage(messageId: string): Promise<MessageDetail> {
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
      body: this.toBody(message),
    };
  }

  private toBody(message: Message): MessageDetail["body"] {
    const content = message.body?.content;
    if (content === undefined || content === null) return null;

    if (message.body?.contentType === "html") {
      const sanitized = sanitizeEmailHtml(content);
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

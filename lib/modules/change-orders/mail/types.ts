import type { BodyEdit, BodySegment } from "./body-text";

/**
 * The vocabulary the rest of the platform uses for mail.
 *
 * These are the platform's own shapes, not Graph's. Route handlers and
 * components see only these: no @odata fields, no changeKey, no
 * singleValueExtendedProperties, no Graph pagination URLs. Exchange IDs appear
 * only as opaque strings - callers pass them back, never parse them.
 */

export interface MailAddress {
  /** Display name when Exchange has one. */
  name: string | null;
  address: string;
}

/** Well-known folders keep their Exchange name; the Projects tree does not. */
export interface MailFolderSummary {
  id: string;
  displayName: string;
  parentFolderId: string | null;
  totalItemCount: number;
  unreadItemCount: number;
  childFolderCount: number;
  /** "inbox", "drafts", "sentitems", ... or null for a user-created folder. */
  wellKnownName: string | null;
}

/** Metadata only. Never a body - listing a folder must not stream bodies. */
export interface MessageSummary {
  id: string;
  conversationId: string | null;
  subject: string | null;
  from: MailAddress | null;
  to: MailAddress[];
  receivedDateTime: string | null;
  isDraft: boolean;
  isRead: boolean;
  hasAttachments: boolean;
}

export interface MessageBody {
  /** Always sanitized when `format` is "html". Never the raw vendor markup. */
  content: string;
  format: "html" | "text";
  /** Remote images removed by the sanitizer, for an honest UI prompt. */
  remoteImagesBlocked: number;
  /**
   * Inline (`cid:`) images - attachments on this message that cannot be
   * rendered yet. Reported so the placeholder has an explanation beside it
   * rather than looking like a failure.
   */
  inlineImages: number;
}

export interface MessageDetail extends MessageSummary {
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  sentDateTime: string | null;
  body: MessageBody | null;
  /** Present on automation drafts as `[CO: Owner|Bulletin]`; parsed later. */
  parentFolderId: string | null;
}

/**
 * Attachment metadata. No content, by design - Phase 4 does not download
 * attachment bytes, and nothing persists them ever.
 */
export interface AttachmentSummary {
  id: string;
  name: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  isInline: boolean;
  /** A message forwarded as an attachment rather than a file. */
  isItemAttachment: boolean;
}

/**
 * `nextCursor` is an opaque continuation, derived from the @odata.nextLink so
 * callers never handle a Graph URL. Null means the last page.
 *
 * Opaque is not a formality. Graph continues a mail collection with `$skip` and
 * other collections with `$skiptoken`, so the cursor encodes which - a caller
 * that assumed either would be wrong half the time.
 */
export interface MessagePage {
  messages: MessageSummary[];
  nextCursor: string | null;
  /**
   * The result set was capped and there are matches this response does not
   * contain.
   *
   * Only a search can set this, and only because a search has to collect its
   * whole result set before it can order it - Graph refuses to order a filtered
   * message collection, so the sort happens here. A folder listing is paged
   * rather than capped, so it is always false there: a cursor means "there is
   * more", which is a different statement from "some was dropped".
   *
   * Returned rather than only logged because a search that quietly stopped at
   * its cap looks exactly like a complete answer.
   */
  truncated: boolean;
}

/**
 * Which cap a grouped listing hit, when it hit one.
 *
 * See truncationOf() in ./conversations.ts. The two are not interchangeable: a
 * folder cap drops the oldest messages, a search cap drops an arbitrary subset,
 * and only one of those lets a group claim its newest message is present.
 */
export type ConversationTruncation = "folder_cap" | "search_cap";

/**
 * One thread, as the message pane renders it.
 *
 * Display only. There is no operation anywhere that takes a `ConversationGroup`
 * - `messages` is carried so the UI can render individual rows, and every move,
 * delete, edit and send still names a single message id. CLAUDE.md: the moment a
 * group can be acted on as a unit, the one-human-one-message rule is at risk.
 */
export interface ConversationGroup {
  /**
   * `c:<conversationId>`, or `m:<messageId>` for a message Exchange gave no
   * conversation id. Not a Graph identifier and not addressable - it exists so
   * React has a key and the UI can remember which rows are expanded.
   */
  id: string;
  /** The NEWEST message's subject, preserved byte for byte. */
  subject: string | null;
  /** Senders in the order they first appear, or recipients if there are none. */
  participants: MailAddress[];
  messageCount: number;
  /** Received and unread. A draft is never counted as unread. */
  unreadCount: number;
  /**
   * Unsent drafts in this thread.
   *
   * Surfaced on the group rather than left inside `messages` because a collapsed
   * group must still show its drafts - reviewing them is the job, and a draft
   * hidden behind a collapsed row is the one message in this mailbox nobody can
   * afford to miss.
   */
  draftCount: number;
  hasAttachments: boolean;
  /** Drives group ordering. Newest group first, like the flat list. */
  newestDateTime: string | null;
  /** Oldest first: PHASE-9 asks for the individual messages "newest last". */
  messages: MessageSummary[];
}

/**
 * A grouped listing.
 *
 * There is no cursor, and that is the design decision of this phase rather than
 * an omission. A conversation assembled from one page is incomplete and looks
 * complete: the row states "4 messages" when the thread has nine, and Graph
 * offers no per-message conversation size to notice it with (`conversationIndex`
 * encodes threading position, not count). So a grouped read collects the folder
 * to a cap and groups the whole set - the same collect-then-order approach
 * searchMessages already uses, and for the same reason: page-by-page ordering
 * looks right and is not.
 *
 * `truncated` therefore carries real weight here. It is the only case in which a
 * group can be missing messages, and `truncation` says which end they went off.
 */
export interface ConversationPage {
  conversations: ConversationGroup[];
  /** Messages grouped, after de-duplication. The sum of the group counts. */
  messageCount: number;
  truncated: boolean;
  truncation: ConversationTruncation | null;
}

export interface ListMessagesOptions {
  top?: number;
  /** The `nextCursor` from a previous page. Never a Graph URL. */
  cursor?: string;
}

/**
 * A draft as the editor needs it.
 *
 * `body` here is the RAW stored body, not the sanitized one getMessage returns.
 * That is deliberate and narrow: saving the sanitized version back would write
 * the lossy copy over the original every time somebody touched a draft, quietly
 * destroying the formatting Power Automate produced.
 *
 * It is only ever put in a textarea, which does not parse markup, and only ever
 * for a message where isDraft is true. The reading pane still renders through
 * the sanitizer and the sandboxed iframe.
 */
export interface DraftForEdit {
  id: string;
  subject: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  body: string;
  bodyFormat: "html" | "text";
  /**
   * The editable text runs in the body, for the text-only editor.
   *
   * Empty for a plain-text body, which is already readable and is edited
   * whole. For HTML, editing these and splicing by source offset is what lets
   * a reviewer fix a date without the message losing its table styling -
   * measured against the real mailbox, sanitizing an automation body keeps 0
   * of its 12-28 style attributes.
   */
  segments: BodySegment[];
  /**
   * The same body, sanitized, for the preview beside the editor.
   *
   * Derived here rather than in the browser so there is still exactly one
   * function that turns a vendor body into something renderable. It is computed
   * from the `body` above, so a save that changes the body changes this in the
   * same response - the preview cannot drift from what Exchange holds, which it
   * did when the editor previewed a copy fetched when the message was opened.
   */
  preview: MessageBody | null;
  hasAttachments: boolean;
  /**
   * Exchange's version marker. Sent back with a save so the service can notice
   * that Outlook changed the draft underneath the editor.
   */
  changeKey: string | null;
  lastModifiedDateTime: string | null;
}

/** Only the fields Phase 6 permits editing. Attachments are never touched. */
export interface DraftChanges {
  subject?: string;
  to?: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  body?: { content: string; format: "html" | "text" };
  /**
   * Edits to individual text runs, applied to the body currently in Exchange.
   * Every byte outside an edited run is preserved exactly.
   */
  bodyEdits?: BodyEdit[];
  /** A paragraph appended before </body>. Nothing existing is rewritten. */
  appendNote?: string;
  /** The changeKey the editor last saw. Omit to save unconditionally. */
  expectedChangeKey?: string | null;
}

/**
 * Which Graph operation produces the derived draft.
 *
 * A closed set, and it maps one-to-one onto `createReply`, `createReplyAll` and
 * `createForward`. There is deliberately no "build a reply myself" member:
 * docs/03 - concatenating the original body into a new message loses the
 * quoting, the In-Reply-To and References headers, and the conversation
 * threading that Intake 6 matches replies by.
 */
export type DerivedDraftMode = "reply" | "replyAll" | "forward";

/**
 * A draft created from scratch.
 *
 * Every field is optional except in one respect: outside production the subject
 * has to satisfy the ZZTEST fence, and for a message that does not exist yet the
 * caller is the only possible source of it. See createDraft().
 */
export interface NewDraftInput {
  subject?: string;
  to?: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  body?: { content: string; format: "html" | "text" };
}

/**
 * What a move did.
 *
 * `idChanged` exists because it should never be true. Exchange gives a moved
 * message a new ID unless immutable IDs are in use - they are, on every request,
 * via the middleware - so this is the assertion that the header is still doing
 * its job, reported rather than assumed.
 */
export interface MoveResult {
  id: string;
  previousId: string;
  idChanged: boolean;
  destinationFolderId: string;
  subject: string | null;
}

/**
 * What a delete moved to Deleted Items.
 *
 * `id` is included because a delete is implemented as a move - see
 * deleteMessage() - and a caller that wants to offer an undo needs the id the
 * message has now. With immutable ids in effect it is the id it always had.
 */
export interface DeleteResult {
  subject: string | null;
  id: string;
}

/** An attachment on its way into a draft. Never persisted anywhere. */
export interface AttachmentUpload {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * An attachment on its way out to a browser.
 *
 * `bytes` is held in memory for the length of one response and then dropped.
 * docs/03: attachment content is never persisted - not to disk, not to the
 * database, not to a cache.
 */
export interface AttachmentDownload {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface GetMessageOptions {
  /**
   * The "show images" affordance. Off unless a person asks for this message,
   * because loading a remote image tells the sender it was opened, by whom and
   * when.
   */
  allowRemoteImages?: boolean;
}

/** What the health endpoint reports. */
export type MailboxConnectionStatus =
  | { configured: true; mailbox: string }
  | { configured: false; missing: string[] };

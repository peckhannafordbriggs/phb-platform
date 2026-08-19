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
  /** The changeKey the editor last saw. Omit to save unconditionally. */
  expectedChangeKey?: string | null;
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

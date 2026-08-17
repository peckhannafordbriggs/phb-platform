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
 * `nextSkipToken` is Graph's opaque continuation token, extracted from the
 * @odata.nextLink so callers never handle a Graph URL. Null means the last page.
 */
export interface MessagePage {
  messages: MessageSummary[];
  nextSkipToken: string | null;
}

export interface ListMessagesOptions {
  top?: number;
  skipToken?: string;
}

/** What the health endpoint reports. */
export type MailboxConnectionStatus =
  | { configured: true; mailbox: string }
  | { configured: false; missing: string[] };

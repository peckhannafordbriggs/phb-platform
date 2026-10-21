import type { MessageSummary } from "@/lib/modules/change-orders/mail/types";
import type {
  ReviewGroup,
  ReviewNote,
  ReviewSummary,
} from "@/lib/modules/change-orders/review/notes";
import { apiGet } from "./mailbox-client";

/**
 * The browser's view of the Needs Review API. The same `{ data }` /
 * `{ error }` envelope as the mailbox, the same ApiError, so the components
 * branch on a code the platform defined and never on an HTTP status.
 */

/** The code every review route answers with until the folder grant lands. */
export const REVIEW_NOT_CONFIGURED = "review_not_configured";

export interface ReviewListingResult {
  summary: ReviewSummary;
  groups: ReviewGroup[];
}

export type MailboxMatch =
  | {
      status: "matched";
      message: MessageSummary;
      candidates: number;
      day: string;
      /** How the pairing was made; the screen says it beside the email. */
      matchedBy: "message_id_and_time" | "subject_and_time";
    }
  | { status: "none"; day: string | null }
  | { status: "unavailable" };

export interface ReviewNoteResult {
  note: ReviewNote;
  mailbox: MailboxMatch;
}

const BASE = "/api/modules/change-orders/review";

export function fetchReviewListing(signal?: AbortSignal): Promise<ReviewListingResult> {
  return apiGet(BASE, signal);
}

export function fetchReviewCount(signal?: AbortSignal): Promise<ReviewSummary> {
  return apiGet(`${BASE}/count`, signal);
}

export function fetchReviewNote(noteId: string, signal?: AbortSignal): Promise<ReviewNoteResult> {
  return apiGet(`${BASE}/notes/${encodeURIComponent(noteId)}`, signal);
}

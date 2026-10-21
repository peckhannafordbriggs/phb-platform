import { ok } from "@/lib/api/response";
import { logger } from "@/lib/logger";
import { isMailError } from "@/lib/modules/change-orders/mail/errors";
import {
  mailService,
  mailboxConnectionStatus,
} from "@/lib/modules/change-orders/mail/service";
import type { MessageMatchCandidate } from "@/lib/modules/change-orders/mail/types";
import {
  chooseMatch,
  searchWindow,
  type MatchedBy,
} from "@/lib/modules/change-orders/review/match";
import type { ReviewNote } from "@/lib/modules/change-orders/review/notes";
import { withReview } from "@/lib/modules/change-orders/review/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/change-orders/review/notes/[noteId]";

/**
 * How the note's email was looked for, and what was found.
 *
 * `unavailable` is the mailbox being unconfigured or unreachable, and it never
 * fails the note: the note is the thing somebody came for, and the email is
 * the thing beside it.
 */
export type MailboxMatch =
  | {
      status: "matched";
      message: MessageMatchCandidate;
      candidates: number;
      day: string;
      matchedBy: MatchedBy;
    }
  | { status: "none"; day: string | null }
  | { status: "unavailable" };

/**
 * One note, with the mailbox message it is about.
 *
 * The note is read from SharePoint; the message is found in Exchange by the
 * note's subject and date (review/match.ts) and returned as a summary. The
 * browser then opens it through the mailbox's own message route, so the body
 * passes through the sanitizer and the sandboxed pane, and attachments
 * through the streaming route, exactly as they do from the Mailbox tab.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ noteId: string }> },
) {
  return withReview(ROUTE, async (service) => {
    const { noteId } = await params;
    const note = await service.readNote(noteId);
    const mailbox = await findMailboxMessage(note);
    return ok({ note, mailbox });
  });
}

async function findMailboxMessage(note: ReviewNote): Promise<MailboxMatch> {
  const day = note.fileDate ?? note.receivedDate;
  const window = day === null ? null : searchWindow(day);
  if (note.subject === null || day === null || window === null) {
    return { status: "none", day };
  }

  if (!mailboxConnectionStatus().configured) return { status: "unavailable" };

  let candidates: MessageMatchCandidate[];
  try {
    candidates = await mailService().findMessagesReceivedBetween(
      note.subject,
      window.from,
      window.to,
    );
  } catch (error) {
    // Already logged by the mail service when it is a MailError; anything else
    // is logged here so a bug in the lookup is not silently "unavailable".
    if (!isMailError(error)) {
      logger.error("review.mailbox_lookup_failed", {
        route: ROUTE,
        outcome: "unavailable",
        reason: error instanceof Error ? error.name : typeof error,
      });
    }
    return { status: "unavailable" };
  }

  const choice = chooseMatch(candidates, day, note.fileTime, note.fileMessageIdHint);
  return choice === null
    ? { status: "none", day }
    : {
        status: "matched",
        message: choice.message,
        candidates: candidates.length,
        day,
        matchedBy: choice.matchedBy,
      };
}

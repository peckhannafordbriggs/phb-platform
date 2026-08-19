import { ok } from "@/lib/api/response";
import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { logUnexpected } from "@/lib/logger";
import { withMailbox } from "@/lib/modules/change-orders/mail/route-helpers";
import {
  assertDraftNotLockedByAnother,
  releaseDraftLock,
} from "@/lib/modules/change-orders/mail/draft-locks";
import { draftSendSchema } from "@/lib/validation/draft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/change-orders/drafts/[messageId]/send";

/**
 * Sends one existing draft.
 *
 * The most consequential endpoint in the platform, and the narrowest on purpose.
 * It takes no recipients, no subject and no content - only the id in the path and
 * the version the sender reviewed. There is no shape of request to this route
 * that sends a message the mailbox did not already contain, and no shape that
 * sends more than one.
 *
 * CLAUDE.md prohibition 1: one human, one draft, one deliberate action, having
 * seen the content. There is deliberately no bulk route, no "send all", no
 * scheduled send, and no way to reach this without a message id somebody opened.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  return withMailbox(
    ROUTE,
    async (service, viewer, input) => {
    const { messageId } = await params;

    await assertDraftNotLockedByAnother(messageId, viewer.id);

    // Throws unless PHB_ALLOW_SEND is exactly "true", and - outside production -
    // unless the subject read from Exchange begins with ZZTEST. Both live in the
    // service so no route, including this one, can skip them.
    const sent = await service.sendDraft(messageId, {
      expectedChangeKey: input.expectedChangeKey,
    });

    /**
     * The audit row, written after the send succeeded.
     *
     * Ordering is deliberate. Writing it first would record sends that never
     * happened, which is worse than the alternative: this row is the record
     * people will reason from, and a false entry is a false alibi.
     *
     * Under app-only auth Exchange records the application as the sender, not
     * the person - so this is the ONLY place the human is recorded. If the
     * insert itself fails, the same facts go to the log at error level rather
     * than being lost, because the message has already gone and cannot be
     * unsent.
     */
    try {
      await writeAuditEvent(prisma, {
        action: "mail.sent",
        actorEmployeeId: viewer.id,
        targetEmployeeId: viewer.id,
        moduleKey: "change-orders",
        metadata: {
          messageId,
          subject: sent.subject,
          to: sent.to.map((a) => a.address),
          cc: sent.cc.map((a) => a.address),
          bcc: sent.bcc.map((a) => a.address),
          sentAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logUnexpected("mail.sent_audit_failed", error, {
        route: ROUTE,
        employeeId: viewer.id,
        outcome: "sent_without_audit_row",
        reason: `messageId=${messageId} recipients=${sent.to.length}`,
      });
    }

    // The draft no longer exists, so neither should its lock.
    await releaseDraftLock(messageId, viewer.id);

      return ok({
        sent: true,
        subject: sent.subject,
        to: sent.to,
        cc: sent.cc,
      });
    },
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = draftSendSchema.safeParse(body);
      return parsed.success
        ? { ok: true, data: parsed.data }
        : { ok: false, message: parsed.error.issues[0]?.message };
    },
  );
}

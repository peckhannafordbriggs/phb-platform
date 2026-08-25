import { ok } from "@/lib/api/response";
import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { withMailbox } from "@/lib/modules/change-orders/mail/route-helpers";
import { assertDraftNotLockedByAnother } from "@/lib/modules/change-orders/mail/draft-locks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE =
  "/api/modules/change-orders/drafts/[messageId]/attachments/[attachmentId]";

/**
 * Removes one attachment from a draft.
 *
 * Under `/drafts/`, not `/messages/`, and that is the contract rather than a
 * naming preference: an attachment can only be removed from something that has
 * not been sent. The service refuses a non-draft regardless - a sent message is
 * the record of what actually went, and editing that record is falsifying it -
 * so this path is the honest name for what the route can do.
 *
 * A draft the automation created already carries attachments downstream flows
 * expect. Removing one is a legitimate human decision; the response is the
 * refreshed list, so "the others survived" is something the person sees rather
 * than something they hope.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ messageId: string; attachmentId: string }> },
) {
  return withMailbox(ROUTE, async (service, viewer) => {
    const { messageId, attachmentId } = await params;

    await assertDraftNotLockedByAnother(messageId, viewer.id);

    const attachments = await service.removeDraftAttachment(messageId, attachmentId);

    await writeAuditEvent(prisma, {
      action: "mail.attachment_removed",
      actorEmployeeId: viewer.id,
      targetEmployeeId: viewer.id,
      moduleKey: "change-orders",
      // The id, and how many are left. The name is not read back: doing so would
      // cost a request for a resource that no longer exists.
      metadata: { messageId, attachmentId, remaining: attachments.length },
    });

    return ok({ attachments });
  });
}

import { ok } from "@/lib/api/response";
import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { withMailbox } from "@/lib/modules/change-orders/mail/route-helpers";
import { releaseDraftLock } from "@/lib/modules/change-orders/mail/draft-locks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/change-orders/messages/[messageId]";

/**
 * One message, with its attachment metadata.
 *
 * `?images=1` re-reads it with remote images allowed - the "show images"
 * affordance. Off by default: loading a remote image tells the sender the mail
 * was opened, by whom and when.
 *
 * Attachments are fetched alongside the message rather than from a second route,
 * because the reading pane always wants both and two round trips would show the
 * names arriving after the body.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  return withMailbox(
    "/api/modules/change-orders/messages/[messageId]",
    async (service) => {
      const { messageId } = await params;
      const allowRemoteImages =
        new URL(request.url).searchParams.get("images") === "1";

      const message = await service.getMessage(messageId, { allowRemoteImages });

      // Names and sizes only - never content. Skipped entirely when the message
      // has none, which is the common case for an automation draft.
      const attachments = message.hasAttachments
        ? await service.listAttachments(messageId)
        : [];

      return ok({ message, attachments, remoteImagesAllowed: allowRemoteImages });
    },
  );
}

/**
 * Deletes one message, to Deleted Items.
 *
 * `DELETE /messages/{id}` is Exchange's soft delete: the message lands in
 * Deleted Items and can be dragged back out in Outlook. The UI says exactly
 * that rather than implying permanence, because implying permanence would make
 * people avoid an operation that is safe.
 *
 * There is no permanent-delete route, and there is not going to be one.
 * CLAUDE.md and docs/03 both forbid exposing `permanentDelete` - not behind a
 * confirmation, not in an admin screen - and a test asserts the string appears
 * nowhere in the module.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  return withMailbox(ROUTE, async (service, viewer) => {
    const { messageId } = await params;

    const deleted = await service.deleteMessage(messageId);

    // Required by PHASE-8: a delete writes an audit event. The subject is what
    // makes the row useful - an opaque Exchange id tells an operator nothing
    // about which message somebody has to go and recover.
    await writeAuditEvent(prisma, {
      action: "mail.deleted",
      actorEmployeeId: viewer.id,
      targetEmployeeId: viewer.id,
      moduleKey: "change-orders",
      metadata: {
        messageId,
        subject: deleted.subject,
        destination: "deleteditems",
      },
    });

    // A deleted draft has no editor to hold a lock for it.
    await releaseDraftLock(messageId, viewer.id);

    return ok({ deleted: true, subject: deleted.subject });
  });
}

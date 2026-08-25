import { ok } from "@/lib/api/response";
import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { withMailbox } from "@/lib/modules/change-orders/mail/route-helpers";
import { moveMessageSchema } from "@/lib/validation/draft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/change-orders/messages/[messageId]/move";

/**
 * Moves one message into one folder.
 *
 * Filing into `Projects` or a project subfolder is the realistic case, because
 * that is where the automation files things and where a person filing by hand
 * would put it. The folder tree the picker uses is the same one the workspace
 * already reads, so no new notion of "where a message may go" exists.
 *
 * The response carries `idChanged`, which should always be false: immutable IDs
 * are requested on every Graph request, so the id survives the move. It is
 * reported rather than assumed because if it ever became true, every id the
 * browser is holding would be stale and the symptom would be messages that
 * cannot be reopened.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  return withMailbox(
    ROUTE,
    async (service, viewer, input) => {
      const { messageId } = await params;

      const moved = await service.moveMessage(messageId, input.destinationFolderId);

      // Required by PHASE-8: a move writes an audit event. Under app-only auth
      // Exchange records the application as having moved it, so this row is the
      // only record of who did.
      await writeAuditEvent(prisma, {
        action: "mail.moved",
        actorEmployeeId: viewer.id,
        targetEmployeeId: viewer.id,
        moduleKey: "change-orders",
        metadata: {
          messageId: moved.previousId,
          newMessageId: moved.id,
          idChanged: moved.idChanged,
          destinationFolderId: moved.destinationFolderId,
          subject: moved.subject,
        },
      });

      return ok(moved);
    },
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = moveMessageSchema.safeParse(body);
      return parsed.success
        ? { ok: true, data: parsed.data }
        : { ok: false, message: parsed.error.issues[0]?.message };
    },
  );
}

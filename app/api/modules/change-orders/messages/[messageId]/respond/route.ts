import { ok } from "@/lib/api/response";
import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { withMailbox } from "@/lib/modules/change-orders/mail/route-helpers";
import { acquireDraftLock } from "@/lib/modules/change-orders/mail/draft-locks";
import { derivedDraftSchema } from "@/lib/validation/draft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/change-orders/messages/[messageId]/respond";

/**
 * Reply, reply-all or forward: creates a draft in Exchange from the message in
 * the path, and returns it in the shape the Phase 6 editor already reads.
 *
 * One route for the three modes, because they are one decision - "start a
 * message from this one" - and Exchange does all the work that differs between
 * them. Three near-identical route files would be three places for the audit
 * row, the lock and the response shape to drift.
 *
 * This route creates and returns. It does not send: the draft goes into the
 * editor, a person reads it, and the send is a separate deliberate request to
 * the send route. There is no path from here to an outbound message.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  return withMailbox(
    ROUTE,
    async (service, viewer, input) => {
      const { messageId } = await params;

      /**
       * Graph's own operation, per mode. Never string assembly.
       *
       * docs/03: `createReply` and friends return a real draft with the quoting,
       * the In-Reply-To and References headers, and the source conversationId.
       * Intake 6 matches replies by conversation ID, so a hand-built reply
       * breaks the automation's filing silently.
       */
      const draft =
        input.mode === "reply"
          ? await service.createReplyDraft(messageId)
          : input.mode === "replyAll"
            ? await service.createReplyAllDraft(messageId)
            : await service.createForwardDraft(messageId);

      // The person who asked for the draft is the one about to edit it, so the
      // lock is taken here rather than on the editor's first read - the same
      // reasoning as opening a draft for editing.
      const lock = await acquireDraftLock(draft.id, viewer.id);

      await writeAuditEvent(prisma, {
        action: "mail.draft_created",
        actorEmployeeId: viewer.id,
        targetEmployeeId: viewer.id,
        moduleKey: "change-orders",
        metadata: {
          mode: input.mode,
          draftId: draft.id,
          sourceMessageId: messageId,
        },
      });

      return ok({ draft, lock });
    },
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = derivedDraftSchema.safeParse(body);
      return parsed.success
        ? { ok: true, data: parsed.data }
        : { ok: false, message: parsed.error.issues[0]?.message };
    },
  );
}

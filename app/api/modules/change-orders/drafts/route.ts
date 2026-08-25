import { ok } from "@/lib/api/response";
import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { withMailbox } from "@/lib/modules/change-orders/mail/route-helpers";
import { acquireDraftLock } from "@/lib/modules/change-orders/mail/draft-locks";
import { newDraftSchema } from "@/lib/validation/draft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/change-orders/drafts";

/**
 * Creates a draft from scratch, which then opens in the Phase 6 editor.
 *
 * The least-used entry point in the module, and deliberately the plainest: most
 * change-order mail originates from the automation. It exists so that the one
 * message a month somebody has to write themselves does not send them back to
 * Outlook.
 *
 * There is no compose window with its own send button. This returns a draft id
 * and the editor takes it from there, so the splice-based body editing, the
 * autosave, the lock, the confirmation dialog and the audit row are the same
 * ones every other draft goes through.
 */
export async function POST(request: Request) {
  return withMailbox(
    ROUTE,
    async (service, viewer, input) => {
      const draft = await service.createDraft(input);
      const lock = await acquireDraftLock(draft.id, viewer.id);

      await writeAuditEvent(prisma, {
        action: "mail.draft_created",
        actorEmployeeId: viewer.id,
        targetEmployeeId: viewer.id,
        moduleKey: "change-orders",
        // No source message: that is what distinguishes a composed draft from a
        // reply in the audit trail.
        metadata: { mode: "compose", draftId: draft.id, sourceMessageId: null },
      });

      return ok({ draft, lock }, 201);
    },
    async () => {
      const body: unknown = await request.json().catch(() => null);
      // An absent body is a valid "create me an empty draft".
      const parsed = newDraftSchema.safeParse(body ?? {});
      return parsed.success
        ? { ok: true, data: parsed.data }
        : { ok: false, message: parsed.error.issues[0]?.message };
    },
  );
}

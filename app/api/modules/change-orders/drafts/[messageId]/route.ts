import { ok } from "@/lib/api/response";
import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { withMailbox } from "@/lib/modules/change-orders/mail/route-helpers";
import {
  acquireDraftLock,
  assertDraftNotLockedByAnother,
  readDraftLock,
} from "@/lib/modules/change-orders/mail/draft-locks";
import { draftPatchSchema } from "@/lib/validation/draft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/change-orders/drafts/[messageId]";

/**
 * The draft as the editor needs it, plus who holds the edit lock.
 *
 * Opening a draft for editing takes the lock, because opening the editor IS the
 * intent to edit. Taking it on first keystroke instead would mean two people
 * could both open the same draft and only discover the collision after typing.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  return withMailbox(ROUTE, async (service, viewer) => {
    const { messageId } = await params;
    const allowRemoteImages =
      new URL(request.url).searchParams.get("images") === "1";

    const draft = await service.getDraftForEdit(messageId, { allowRemoteImages });
    const lock = await acquireDraftLock(messageId, viewer.id);

    return ok({ draft, lock });
  });
}

/**
 * Saves an edit. Called by autosave and by an explicit save.
 *
 * Every rule that matters is enforced below this route, in the service: the
 * message must be a draft, the ZZTEST fence applies with the subject read from
 * Exchange, and a stale changeKey is refused rather than overwritten.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  return withMailbox(
    ROUTE,
    async (service, viewer, input) => {
    const { messageId } = await params;

    // A colleague editing the same draft blocks the save. Outlook does not, and
    // cannot - the UI says so rather than pretending otherwise.
    await assertDraftNotLockedByAnother(messageId, viewer.id);

    const { expectedChangeKey, ...changes } = input;
    // Only decides how the preview in the response is rendered. It reaches no
    // write: the sanitized copy is never what gets saved.
    const allowRemoteImages =
      new URL(request.url).searchParams.get("images") === "1";

    const draft = await service.updateDraft(
      messageId,
      { ...changes, expectedChangeKey },
      { allowRemoteImages },
    );

    // Refresh the lock on every save, so an active editor never loses it.
    const lock = await acquireDraftLock(messageId, viewer.id);

    // The edit itself is audited without its content: who touched which draft,
    // and which fields. Never the body.
    await writeAuditEvent(prisma, {
      action: "mail.draft_edited",
      actorEmployeeId: viewer.id,
      targetEmployeeId: viewer.id,
      moduleKey: "change-orders",
      metadata: {
        messageId,
        fields: Object.keys(changes).sort(),
      },
    });

      return ok({ draft, lock });
    },
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = draftPatchSchema.safeParse(body);
      return parsed.success
        ? { ok: true, data: parsed.data }
        : { ok: false, message: parsed.error.issues[0]?.message };
    },
  );
}

/** Releases the lock when the editor closes. Expiry covers the tab that never does. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  return withMailbox(ROUTE, async (_service, viewer) => {
    const { messageId } = await params;

    const { releaseDraftLock } = await import(
      "@/lib/modules/change-orders/mail/draft-locks"
    );
    await releaseDraftLock(messageId, viewer.id);

    return ok(await readDraftLock(messageId, viewer.id));
  });
}

import { ok } from "@/lib/api/response";
import { withMailbox } from "@/lib/modules/change-orders/mail/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

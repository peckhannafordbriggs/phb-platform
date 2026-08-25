import { ok } from "@/lib/api/response";
import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { withMailbox } from "@/lib/modules/change-orders/mail/route-helpers";
import { assertDraftNotLockedByAnother } from "@/lib/modules/change-orders/mail/draft-locks";
import {
  MAX_ATTACHMENT_BYTES,
  safeAttachmentName,
} from "@/lib/modules/change-orders/mail/attachments";
import type { AttachmentUpload } from "@/lib/modules/change-orders/mail/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/change-orders/drafts/[messageId]/attachments";

/**
 * Adds one attachment to a draft.
 *
 * One, not several. A multi-file upload would mean one request that changes a
 * message several times, and a partial failure halfway through leaves a draft
 * nobody has seen the current state of - which is exactly the situation the send
 * confirmation exists to prevent.
 *
 * `multipart/form-data` rather than base64 JSON: the browser already has the
 * file, and base64 in a JSON body costs a third more bytes both ways for no
 * benefit. The service does the base64 encoding Graph wants, where the size is
 * already known and bounded.
 *
 * Every rule about WHAT may be attached lives in the service and in
 * mail/attachments.ts, not here - executable content, oversize, empty files and
 * unsafe names are refused below this route, so no future route can skip them.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  return withMailbox<AttachmentUpload>(
    ROUTE,
    async (service, viewer, upload) => {
      const { messageId } = await params;

      // A colleague editing the same draft blocks the change, exactly as it
      // blocks a save. Adding a file to a draft somebody else is composing is
      // the same class of surprise as rewriting their subject.
      await assertDraftNotLockedByAnother(messageId, viewer.id);

      const attachments = await service.addDraftAttachment(messageId, upload);

      await writeAuditEvent(prisma, {
        action: "mail.attachment_added",
        actorEmployeeId: viewer.id,
        targetEmployeeId: viewer.id,
        moduleKey: "change-orders",
        // Name and size. Never the content - docs/03, and an audit row is not a
        // place to start persisting attachment bytes.
        metadata: {
          messageId,
          name: upload.name,
          sizeBytes: upload.bytes.byteLength,
          attachmentCount: attachments.length,
        },
      });

      return ok({ attachments });
    },
    async () => {
      /**
       * The size check happens twice, and both are necessary.
       *
       * Here, so an oversized upload is refused after the body has been read but
       * before anything is sent to Graph. And in the service, so a caller that
       * never came through this route cannot skip it.
       */
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return { ok: false, message: "Send the file as multipart form data." };
      }

      const file = form.get("file");
      if (!(file instanceof File)) {
        return { ok: false, message: "No file was included in the upload." };
      }

      if (file.size > MAX_ATTACHMENT_BYTES) {
        // Reported as a validation failure rather than a MailError, because at
        // this point nothing has been asked of the mailbox at all.
        return {
          ok: false,
          message: `That file is too large to attach. The limit is ${
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
          } MB.`,
        };
      }

      const bytes = new Uint8Array(await file.arrayBuffer());

      // Belt and braces: File.size is what the browser claimed, this is what
      // actually arrived. The service checks the real length too, so a caller
      // that never came through this route cannot skip it.
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        return {
          ok: false,
          message: `That file is too large to attach. The limit is ${
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
          } MB.`,
        };
      }

      return {
        ok: true,
        data: {
          // Reduced to a bare filename here as well as in the service, so the
          // audit row above records the name that was actually used.
          name: safeAttachmentName(file.name),
          contentType: file.type,
          bytes,
        },
      };
    },
  );
}

import { NextResponse } from "next/server";
import { withMailbox } from "@/lib/modules/change-orders/mail/route-helpers";
import { contentDisposition } from "@/lib/modules/change-orders/mail/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE =
  "/api/modules/change-orders/messages/[messageId]/attachments/[attachmentId]";

/**
 * Streams one attachment through the backend from Graph.
 *
 * Through the backend rather than by handing the browser a Graph URL, for the
 * reason the whole service boundary exists: a Graph URL needs the app-only token
 * attached, and a token that reaches a browser is a token that can read the
 * whole mailbox. The bytes pass through this process and are never written
 * anywhere - no disk, no database, no cache. docs/03: never persist attachment
 * content.
 *
 * This is the one route in the module that does not answer in the platform's
 * `{ data }` envelope, because its body is a file. Failures still do: an error
 * comes back as the usual `{ error: { code, message } }` from `withMailbox`, so
 * the browser can tell "this did not work" from "here is your file" without
 * parsing a binary response.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ messageId: string; attachmentId: string }> },
) {
  return withMailbox(ROUTE, async (service) => {
    const { messageId, attachmentId } = await params;

    const file = await service.downloadAttachment(messageId, attachmentId);

    /**
     * Three independent reasons the browser will not execute this.
     *
     * The content type has already been reduced from anything renderable to
     * `application/octet-stream` in the service, the disposition is `attachment`
     * rather than `inline`, and `nosniff` stops the browser second-guessing the
     * type it was given. A vendor chooses the attachment's declared type, so one
     * of these being enough is not something to rely on.
     *
     * The filename in the header has been through `safeAttachmentName`, so it
     * carries no path separators and no CR or LF - a newline there would be
     * header injection rather than an odd filename.
     */
    return new NextResponse(
      // A fresh copy so the response body cannot be a view over a buffer this
      // process still holds a reference to.
      new Uint8Array(file.bytes),
      {
        status: 200,
        headers: {
          "Content-Type": file.contentType,
          "Content-Length": String(file.bytes.byteLength),
          "Content-Disposition": contentDisposition(file.name),
          "X-Content-Type-Options": "nosniff",
          // Mailbox content must not sit in a shared or disk cache.
          "Cache-Control": "no-store, private",
        },
      },
    );
  });
}

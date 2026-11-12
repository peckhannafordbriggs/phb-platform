import { NextResponse } from "next/server";
import { notFound } from "@/lib/api/response";
import { withInlineImageLink } from "@/lib/modules/change-orders/mail/route-helpers";
import { sniffImageType } from "@/lib/modules/change-orders/mail/inline-images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE =
  "/api/modules/change-orders/messages/[messageId]/inline-images/[attachmentId]";

/**
 * Serves one inline image of one message to the reading pane.
 *
 * This is the one mail route that is NOT behind `withMailbox`, and the reason
 * is measured rather than chosen: the pane is a sandboxed iframe with an opaque
 * origin, and the browser sends no session cookie with the images it loads.
 * The grant-gated message route, having already checked who is asking, signs
 * a link for each image it resolves, and `withInlineImageLink` admits a
 * request on that signature and its expiry alone. lib/modules/change-orders/
 * mail/inline-images.ts has the full reasoning.
 *
 * Through the backend, like the attachment download: a Graph URL needs the
 * app-only token, and a token that reaches a browser can read the whole
 * mailbox. The bytes pass through this process and are written nowhere.
 *
 * Unlike the download route this answers `inline`, because an <img> is what
 * asks for it - so what it will serve is decided from the BYTES, never from
 * the type a vendor declared. A raster image is served as what it is; anything
 * else, SVG above all, is refused. An SVG served inline on the platform's
 * origin and then opened directly would run script in that origin, and the
 * declared type is exactly the thing a vendor controls.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ messageId: string; attachmentId: string }> },
) {
  const { messageId, attachmentId } = await params;

  return withInlineImageLink(
    ROUTE,
    request,
    { messageId, attachmentId },
    async (service) => {
      const file = await service.downloadAttachment(messageId, attachmentId);

      const type = sniffImageType(file.bytes);
      if (type === null) {
        return notFound("That attachment is not an image the pane can show.");
      }

      return new NextResponse(
        // A fresh copy so the response body cannot be a view over a buffer this
        // process still holds a reference to.
        new Uint8Array(file.bytes),
        {
          status: 200,
          headers: {
            "Content-Type": type,
            "Content-Length": String(file.bytes.byteLength),
            "Content-Disposition": "inline",
            // The type above came from the bytes; the browser must not reach
            // a different conclusion of its own.
            "X-Content-Type-Options": "nosniff",
            // If a person opens the link directly rather than through the
            // pane, the response is still a document with no origin, no script
            // and no network - the same posture the pane itself has.
            "Content-Security-Policy": "default-src 'none'; sandbox",
            // Mailbox content must not sit in a shared or disk cache.
            "Cache-Control": "no-store, private",
          },
        },
      );
    },
  );
}

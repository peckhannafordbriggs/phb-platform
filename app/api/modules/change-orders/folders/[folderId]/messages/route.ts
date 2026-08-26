import { ok } from "@/lib/api/response";
import {
  readCursor,
  readTop,
  withMailbox,
} from "@/lib/modules/change-orders/mail/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUERY_LENGTH = 200;

/**
 * One page of a folder's messages, newest first - or, with `q`, one page of
 * search results within that folder.
 *
 * Metadata only. No body is fetched for a listing, so scanning a folder never
 * pulls message content.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ folderId: string }> },
) {
  return withMailbox(
    "/api/modules/change-orders/folders/[folderId]/messages",
    async (service) => {
      const { folderId } = await params;
      const search = new URL(request.url).searchParams;

      const query = search.get("q")?.trim().slice(0, MAX_QUERY_LENGTH) ?? "";
      const options = {
        top: readTop(search),
        cursor: readCursor(search),
      };

      /**
       * A search takes no paging options, and that is not an oversight.
       *
       * Graph refuses to order a filtered message collection, so the service
       * collects the whole result set and sorts it before returning - which
       * means there is nothing left to page through, and a `cursor` or `top` it
       * accepted but ignored would be a trap for the next caller.
       */
      const page =
        query.length > 0
          ? await service.searchMessages(folderId, query)
          : await service.listMessages(folderId, options);

      return ok({
        messages: page.messages,
        nextCursor: page.nextCursor,
        /**
         * Both listings are newest-first now, so there is no longer an `ordered`
         * flag for the client to interpret. A folder listing gets its order from
         * Graph; a search gets it from the service, which sorts the whole result
         * set because Graph refuses to order a filtered collection.
         *
         * `truncated` replaced it, and answers a different question: not "is
         * this ordered" but "is this all of it".
         */
        truncated: page.truncated,
        query,
      });
    },
  );
}

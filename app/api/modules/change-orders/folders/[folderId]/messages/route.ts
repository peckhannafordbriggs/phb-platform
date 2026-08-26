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

      const page =
        query.length > 0
          ? await service.searchMessages(folderId, query, options)
          : await service.listMessages(folderId, options);

      return ok({
        messages: page.messages,
        nextCursor: page.nextCursor,
        /**
         * Search results are not in date order, and this survived the switch
         * from `$search` to `$filter`.
         *
         * Exchange answers 400 InefficientFilter to `$filter` combined with
         * `$orderby` on messages, so a subject search sends no ordering and gets
         * back whatever order Exchange chooses - measured as neither date nor
         * relevance. A plain folder listing DOES order by receivedDateTime desc.
         * The client says which it is looking at rather than implying an order
         * that is not there.
         */
        ordered: query.length === 0,
        query,
      });
    },
  );
}

import { ok } from "@/lib/api/response";
import {
  readCursor,
  readFlag,
  readTop,
  withMailbox,
} from "@/lib/modules/change-orders/mail/route-helpers";
import {
  groupConversations,
  truncationOf,
} from "@/lib/modules/change-orders/mail/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUERY_LENGTH = 200;

/**
 * One page of a folder's messages, newest first - or, with `q`, one page of
 * search results within that folder. With `group=1`, the same messages grouped
 * into conversations instead.
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

      /**
       * Grouping is opt-in at this boundary even though the UI defaults it on.
       *
       * The two modes answer with different shapes and different completeness
       * promises - flat is paged and has a cursor, grouped is capped and has
       * none - so which one a caller wanted is not something to infer. The
       * browser states it on every request.
       */
      const grouped = readFlag(search, "group") === true;

      if (grouped) {
        /**
         * A search is already collected and sorted in full by the service, so
         * grouping it costs no extra request. Its truncation is a DIFFERENT
         * promise from a folder's, though, and is labelled as such: Exchange
         * will not order a filtered collection, so a capped search dropped an
         * arbitrary subset, where a capped folder read dropped the oldest.
         */
        if (query.length > 0) {
          const page = await service.searchMessages(folderId, query);

          return ok({
            grouped: true,
            conversations: groupConversations(page.messages),
            messageCount: page.messages.length,
            nextCursor: null,
            truncated: page.truncated,
            truncation: truncationOf(page.truncated, "search_cap"),
            query,
          });
        }

        const page = await service.listConversations(folderId);

        return ok({
          grouped: true,
          conversations: page.conversations,
          messageCount: page.messageCount,
          // A grouped read has no cursor by design - see listConversations.
          nextCursor: null,
          truncated: page.truncated,
          truncation: page.truncation,
          query,
        });
      }

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
        grouped: false,
        conversations: null,
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
        truncation: truncationOf(page.truncated, "search_cap"),
        query,
      });
    },
  );
}

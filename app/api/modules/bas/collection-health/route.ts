import { z } from "zod";
import {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  MIN_WINDOW_DAYS,
  getCollectionHealth,
} from "@/lib/modules/bas/service";
import { ok, withBas } from "@/lib/modules/bas/route-helpers";

// Prisma needs Node, and every route under app/api/modules/* is database-backed.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/collection-health";

/**
 * The window is the only input, and it is bounded rather than clamped silently.
 *
 * `?days=400` is a caller asking for something this screen does not do, so it is
 * answered 422 instead of quietly served seven days of data and believed to be
 * four hundred. The service clamps as well - two layers, because the service is
 * also called from places that are not this route.
 */
const QuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .min(MIN_WINDOW_DAYS)
    .max(MAX_WINDOW_DAYS)
    .default(DEFAULT_WINDOW_DAYS),
});

/**
 * Everything on the Collection Health screen, in one response.
 *
 * One route rather than one per panel, deliberately. The screen polls, and five
 * tiles that each fetched separately would be five authorization checks, five
 * availability checks and five different `now()` values per refresh - so the
 * tiles could disagree with the table they sit above. See
 * `getCollectionHealth`, which reads all of it inside one transaction.
 */
export async function GET(request: Request) {
  return withBas(
    ROUTE,
    async (viewer, input: { days: number }) =>
      ok(await getCollectionHealth(viewer, { windowDays: input.days })),
    async () => {
      const search = new URL(request.url).searchParams;
      const parsed = QuerySchema.safeParse({
        days: search.get("days") ?? undefined,
      });

      if (!parsed.success) {
        return {
          ok: false,
          message: `days must be a whole number between ${MIN_WINDOW_DAYS} and ${MAX_WINDOW_DAYS}.`,
        };
      }

      return { ok: true, data: parsed.data };
    },
  );
}

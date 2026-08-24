import { z } from "zod";
import { fail } from "@/lib/api/response";
import { BasError } from "@/lib/modules/bas/errors";
import {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  MIN_WINDOW_DAYS,
  getPointExplorer,
  parsePointId,
  parseSiteId,
} from "@/lib/modules/bas/service";
import { ok, withBas } from "@/lib/modules/bas/route-helpers";

// Prisma needs Node, and every route under app/api/modules/* is database-backed.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/point-explorer";

/**
 * Three inputs. Only the window's shape is checked here.
 *
 * Whether a given building or point exists, and whether this employee may see
 * it, are questions only the service can answer - it holds the entitlement and
 * it builds the picker's list. The route's job is to turn its answer into a
 * status, not to second-guess it.
 */
const QuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .min(MIN_WINDOW_DAYS)
    .max(MAX_WINDOW_DAYS)
    .default(DEFAULT_WINDOW_DAYS),
  site: z.string().trim().max(32).optional(),
  point: z.string().trim().max(32).optional(),
});

/**
 * Everything the Point Explorer screen shows, in one response.
 *
 * Same shape as the Collection Health route and for the same reason: the screen
 * polls, and the tiles, the chart and the gap list all have to be measured from
 * one `now()` or they disagree with each other.
 */
export async function GET(request: Request) {
  return withBas(
    ROUTE,
    async (viewer, input: { days: number; site?: string; point?: string }) => {
      try {
        return ok(
          await getPointExplorer(viewer, {
            windowDays: input.days,
            siteId: parseSiteId(input.site),
            pointId: parsePointId(input.point),
          }),
        );
      } catch (error) {
        if (
          error instanceof BasError &&
          (error.code === "site_not_found" || error.code === "point_not_found")
        ) {
          // 404, matching the module guard. A point or building the employee may
          // not see must not be distinguishable from one that does not exist.
          return fail(404, "not_found", error.message);
        }
        throw error;
      }
    },
    async () => {
      const search = new URL(request.url).searchParams;
      const parsed = QuerySchema.safeParse({
        days: search.get("days") ?? undefined,
        site: search.get("site") ?? undefined,
        point: search.get("point") ?? undefined,
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

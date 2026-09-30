import { z } from "zod";
import { fail } from "@/lib/api/response";
import { BasError } from "@/lib/modules/bas/errors";
import {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  MIN_WINDOW_DAYS,
  getPointExplorer,
  parsePointId,
  parseProjectId,
  parseSiteId,
  parseStationId,
} from "@/lib/modules/bas/service";
import { NO_POINT } from "@/lib/modules/bas/constants";
import { ok, withBas } from "@/lib/modules/bas/route-helpers";

// Prisma needs Node, and every route under app/api/modules/* is database-backed.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/point-explorer";

/**
 * Only the SHAPE of the inputs is checked here.
 *
 * Whether a given building or point exists, and whether this employee may see
 * it, are questions only the service can answer - it holds the entitlement and
 * it builds the picker's list. The route's job is to turn its answer into a
 * status, not to second-guess it.
 *
 * The same goes for the custom range. `from` and `to` are checked for being
 * `YYYY-MM-DD` and for arriving as a pair; whether the end is before the start,
 * whether the day exists, and whether the end is in the future are decided by
 * the service, because "the future" depends on the building's time zone and
 * only the service knows which building the point is in. Those come back as
 * `invalid_range` and are answered 422 below.
 */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

const QuerySchema = z
  .object({
    days: z.coerce
      .number()
      .int()
      .min(MIN_WINDOW_DAYS)
      .max(MAX_WINDOW_DAYS)
      .default(DEFAULT_WINDOW_DAYS),
    from: z.string().trim().regex(CALENDAR_DATE).optional(),
    to: z.string().trim().regex(CALENDAR_DATE).optional(),
    site: z.string().trim().max(32).optional(),
    project: z.string().trim().max(32).optional(),
    station: z.string().trim().max(32).optional(),
    point: z.string().trim().max(32).optional(),
  })
  // Both or neither. A start with no end is not a range, and guessing the
  // missing half ("until today"?) would be a decision the person did not make.
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    message: "from and to must be given together",
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
    async (
      viewer,
      input: {
        days: number;
        from?: string;
        to?: string;
        site?: string;
        point?: string;
        project?: string;
        station?: string;
      },
    ) => {
      try {
        return ok(
          await getPointExplorer(viewer, {
            windowDays: input.days,
            range:
              input.from !== undefined && input.to !== undefined
                ? { from: input.from, to: input.to }
                : null,
            siteId: parseSiteId(input.site),
            projectId: parseProjectId(input.project),
            stationId: parseStationId(input.station),
            // `point=none` (a Projects card): the lists, and no point loaded.
            // Anything else is a point id, or absent for the picker's first.
            pointId: input.point === NO_POINT ? null : parsePointId(input.point),
            selectPoint: input.point !== NO_POINT,
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
        if (error instanceof BasError && error.code === "invalid_range") {
          // 422 with the service's own sentence: it names the dates and, for an
          // end in the future, what today is in the building's zone.
          return fail(422, "validation_failed", error.message);
        }
        throw error;
      }
    },
    async () => {
      const search = new URL(request.url).searchParams;
      const parsed = QuerySchema.safeParse({
        days: search.get("days") ?? undefined,
        from: search.get("from") ?? undefined,
        to: search.get("to") ?? undefined,
        site: search.get("site") ?? undefined,
        project: search.get("project") ?? undefined,
        station: search.get("station") ?? undefined,
        point: search.get("point") ?? undefined,
      });

      if (!parsed.success) {
        const paths = new Set(
          parsed.error.issues.flatMap((issue) => issue.path.map(String)),
        );
        const aboutRange = paths.has("from") || paths.has("to") || paths.size === 0;
        return {
          ok: false,
          message: aboutRange
            ? "from and to must both be given, as YYYY-MM-DD."
            : `days must be a whole number between ${MIN_WINDOW_DAYS} and ${MAX_WINDOW_DAYS}.`,
        };
      }

      return { ok: true, data: parsed.data };
    },
  );
}

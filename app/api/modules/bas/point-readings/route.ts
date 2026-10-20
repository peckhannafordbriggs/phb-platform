import { fail } from "@/lib/api/response";
import { BasError } from "@/lib/modules/bas/errors";
import { getPointReadings, parseReadingsQuery, type ReadingsRequest } from "@/lib/modules/bas/readings";
import { ok, withBas } from "@/lib/modules/bas/route-helpers";

// Prisma needs Node, and every route under app/api/modules/* is database-backed.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/point-readings";

/**
 * One page of the raw readings behind the Point Explorer chart.
 *
 * `point`, `from`, `to` (the chart's own `range.from` / `range.to`, ISO UTC
 * instants, end exclusive) and `page`. Fetched by the readings table when it
 * is shown and never by the page itself - see lib/modules/bas/readings.ts.
 *
 * Same answers as the explorer route for the same reasons: a point the
 * employee may not see, or a hidden one, is 404 with the service's sentence;
 * instants out of order are 422.
 */
export async function GET(request: Request) {
  return withBas(
    ROUTE,
    async (viewer, input: ReadingsRequest) => {
      try {
        return ok(await getPointReadings(viewer, input));
      } catch (error) {
        if (error instanceof BasError && error.code === "point_not_found") {
          return fail(404, "not_found", error.message);
        }
        if (error instanceof BasError && error.code === "invalid_range") {
          return fail(422, "validation_failed", error.message);
        }
        throw error;
      }
    },
    async () => parseReadingsQuery(new URL(request.url).searchParams, { page: true }),
  );
}

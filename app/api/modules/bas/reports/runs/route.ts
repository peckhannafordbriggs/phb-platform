import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { listRuns } from "@/lib/modules/bas/reports/runs-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/runs";

/**
 * The runs the viewer may see, newest first, 25 a page (2026-11-23):
 * `?page=<n>`, and `?report=<id>`, `?building=<siteId>`, `?status=<state>`
 * to narrow. An unreadable value is no filter, and the response says which
 * filters it applied and which page it served.
 */
export async function GET(request: Request) {
  return withBas(ROUTE, async (viewer) => {
    const params = new URL(request.url).searchParams;
    const query = { page: params.get("page"), report: params.get("report"), building: params.get("building"), status: params.get("status") };
    return ok(await listRuns(viewer, query));
  });
}

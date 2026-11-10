import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { listRuns } from "@/lib/modules/bas/reports/runs-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/runs";

/** The runs the viewer may see, newest first; `?report=<id>` narrows to one definition. */
export async function GET(request: Request) {
  return withBas(ROUTE, async (viewer) => {
    const report = new URL(request.url).searchParams.get("report");
    return ok(await listRuns(viewer, report));
  });
}

import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { getRun } from "@/lib/modules/bas/reports/runs-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/runs/[runId]";

/** One run with its document. Owner or module admin; anyone else is answered 404. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  return withBas(ROUTE, async (viewer) => {
    const { runId } = await params;
    return reportsResult(
      () => getRun(viewer, runId),
      (run) => ok(run),
    );
  });
}

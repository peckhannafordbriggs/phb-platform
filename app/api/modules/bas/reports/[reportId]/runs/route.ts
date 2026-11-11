import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { requestRun } from "@/lib/modules/bas/reports/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/[reportId]/runs";

/**
 * Run now (Phase 3): queue a run of this report for the worker. Owner or
 * module admin, decided in the service; a second request while one is
 * queued or running is 409 `run_in_flight`. Answers 202 with the run id -
 * accepted, not done: the worker does it.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ reportId: string }> },
) {
  return withBas(ROUTE, async (viewer) => {
    const { reportId } = await params;
    return reportsResult(
      () => requestRun(viewer, reportId),
      (result) => ok(result, 202),
    );
  });
}

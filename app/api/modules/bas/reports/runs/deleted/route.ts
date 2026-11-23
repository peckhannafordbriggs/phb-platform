import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { listDeletedRuns } from "@/lib/modules/bas/reports/runs-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/runs/deleted";

/**
 * Recently deleted (2026-11-20): the viewer's deleted runs - their own
 * reports', or every report's for a module admin - newest deletion first,
 * each with when the scheduler purges it.
 */
export async function GET() {
  return withBas(ROUTE, async (viewer) => ok(await listDeletedRuns(viewer)));
}

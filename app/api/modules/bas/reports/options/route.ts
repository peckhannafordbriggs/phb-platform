import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { listReportOptions } from "@/lib/modules/bas/reports/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/options";

/** What the editor needs before a report exists: the buildings and their stations, the defaults. */
export async function GET() {
  return withBas(ROUTE, async (viewer) => ok(await listReportOptions(viewer)));
}

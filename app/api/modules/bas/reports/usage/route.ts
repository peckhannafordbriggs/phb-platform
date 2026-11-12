import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { getReportsUsage } from "@/lib/modules/bas/reports/usage";
import { parseUsageRange } from "@/lib/usage/range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/usage";

/**
 * Usage & cost over `?range=7d|30d|90d` (2026-11-12): what the Usage page
 * renders, as JSON, over the runs the viewer may see. The page itself reads
 * the service directly; this is the same figures for a script or a test.
 */
export async function GET(request: Request) {
  return withBas(ROUTE, async (viewer) => {
    const range = parseUsageRange(new URL(request.url).searchParams.get("range"));
    return ok(await getReportsUsage(viewer, range));
  });
}

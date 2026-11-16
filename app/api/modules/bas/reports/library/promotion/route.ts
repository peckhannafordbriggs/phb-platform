import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { getPromotionOptions } from "@/lib/modules/bas/reports/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/library/promotion";

/**
 * What the Questions page's promotion form offers (Reports, Phase 6):
 * whether the viewer may promote (a BAS module admin), the sections, and
 * the equipment types and point roles a promoted question may name.
 */
export async function GET() {
  return withBas(ROUTE, async (viewer) => ok(await getPromotionOptions(viewer)));
}

import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { parseBody } from "@/lib/modules/bas/reports/parse";
import { readSafetyCeiling, setSafetyCeiling } from "@/lib/modules/bas/reports/service";
import { safetyCeilingSchema, type SafetyCeilingInput } from "@/lib/validation/bas-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/ceiling";

/**
 * The module's safety ceiling (2026-11-12): the most a run may spend and the
 * longest it may take. Read by anyone with the BAS grant - the Usage page
 * shows it to everyone - and set by a module admin only, which the service
 * decides (`admin_required`, 403) rather than the settings wrapper, because
 * the read half is for every BAS user.
 */
export async function GET() {
  return withBas(ROUTE, async () => ok(await readSafetyCeiling()));
}

export async function PATCH(request: Request) {
  return withBas(
    ROUTE,
    async (viewer, input: SafetyCeilingInput) =>
      reportsResult(
        () => setSafetyCeiling(viewer, input),
        (result) => ok(result),
      ),
    parseBody(request, safetyCeilingSchema),
  );
}

import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import { setBasSiteOccupancy } from "@/lib/modules/bas/settings-service";
import { siteOccupancySchema, type SiteOccupancyInput } from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/buildings/[siteId]/occupancy";

/**
 * Replace a building's occupied hours (Reports, Phase 2). The whole week at
 * once; a weekday left out is unoccupied. Module admin, like every Settings
 * write, and 404 rather than 403 without the flag.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  return withBasSettings(
    ROUTE,
    async (viewer, input: SiteOccupancyInput) => {
      const { siteId } = await params;
      return settingsResult(
        () => setBasSiteOccupancy(viewer, siteId, input),
        (result) => ok(result),
      );
    },
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = siteOccupancySchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues[0]?.message };
      }
      return { ok: true, data: parsed.data };
    },
  );
}

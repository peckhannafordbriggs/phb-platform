import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import { bulkSetPointVisibility } from "@/lib/modules/bas/settings-service";
import {
  bulkVisibilitySchema,
  type BulkVisibilityInput,
} from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/points/bulk-visibility";

/**
 * Hide or show a selection of points (2026-11-20) - Settings → Points, the
 * "Hide" and "Show" actions on a selection.
 *
 * WHAT IT ACCEPTS. `{ pointIds, visible }`: one to 500 distinct point ids and
 * one boolean. Strict - no `isActive`, no `role`, nothing else. A hidden point
 * keeps being collected and stays in every data-loss figure; it leaves the
 * browsing screens, reports, the Analyze catalogue and the stuck-value check.
 *
 * ALL OR NOTHING. A point that does not exist or is out of the viewer's scope
 * refuses the whole selection (404 `point_not_found`) with nothing written.
 *
 * WHAT COMES BACK. `{ points, changed, unchanged }`. One
 * `bas.point_visibility_changed` audit row per point that changed, with
 * `viaBulk: true` and the selection size - the same action the single-point
 * checkbox writes.
 *
 * Its own static segment, beside `points/bulk`, so Next's static match wins
 * over `points/[pointId]`.
 */
export async function POST(request: Request) {
  return withBasSettings(
    ROUTE,
    async (viewer, input: BulkVisibilityInput) =>
      settingsResult(
        () => bulkSetPointVisibility(viewer, input),
        (result) => ok(result),
      ),
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = bulkVisibilitySchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues[0]?.message };
      }
      return { ok: true, data: parsed.data };
    },
  );
}

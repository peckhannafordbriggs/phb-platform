import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import { setBasPointVisibility } from "@/lib/modules/bas/settings-service";
import {
  updatePointSchema,
  type UpdatePointInput,
} from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/points/[pointId]";

/**
 * Show or hide one point on the browsing screens (B8.3).
 *
 * One point, one field. The schema accepts `visible` and nothing else - there
 * is deliberately no way to reach `is_active` from here, because hiding costs
 * nothing and deactivating loses data the station will overwrite, and the two
 * must not sit on one payload. Labels are B8.4 and will PATCH this same path
 * with their own field when they arrive.
 *
 * `withBasSettings`, like every route under settings/**: module-admin grant or
 * 404. A point on a station outside the viewer's scope is also 404, through
 * `point_not_found`, so a point that exists and is not theirs reads the same as
 * one that does not exist.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ pointId: string }> },
) {
  return withBasSettings(
    ROUTE,
    async (viewer, input: UpdatePointInput) => {
      const { pointId } = await params;
      return settingsResult(
        () => setBasPointVisibility(viewer, pointId, input),
        (result) => ok(result),
      );
    },
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = updatePointSchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues[0]?.message };
      }
      return { ok: true, data: parsed.data };
    },
  );
}

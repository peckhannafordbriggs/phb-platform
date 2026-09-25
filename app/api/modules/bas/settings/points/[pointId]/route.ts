import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import {
  setBasPointLabel,
  setBasPointVisibility,
} from "@/lib/modules/bas/settings-service";
import {
  updatePointSchema,
  type UpdatePointInput,
} from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/points/[pointId]";

/**
 * Change one thing about one point: show or hide it (B8.3), or set, change
 * or clear its label (B8.4).
 *
 * One point, one field per request. The schema is strict and accepts
 * `visible` or `label` - never both, never anything else. There is
 * deliberately no way to reach `is_active` from here, because hiding costs
 * nothing and deactivating loses data the station will overwrite, and the two
 * must not sit on one payload. Nor `niagara_history_name`: it is the oBIX key,
 * and editing it stops the point collecting. Each field dispatches to its own
 * service function with its own audit action, so one request is one audit
 * row.
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
        () =>
          input.visible !== undefined
            ? setBasPointVisibility(viewer, pointId, { visible: input.visible })
            : setBasPointLabel(viewer, pointId, { label: input.label ?? null }),
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

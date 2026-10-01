import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import { bulkClassifyPoints } from "@/lib/modules/bas/settings-service";
import {
  bulkClassifySchema,
  type BulkClassifyInput,
} from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/points/bulk";

/**
 * Role and/or equipment on a selection of points, in one transaction (B8.5).
 *
 * WHAT IT ACCEPTS. `{ pointIds, role?, equipmentId? }`: one to 500 distinct
 * point ids, and at least one of the two fields. A field PRESENT with `null`
 * clears it on every point; a field ABSENT leaves it alone. Strict - no
 * `visible`, no `isActive`, nothing else - so a bulk path can never be the way
 * a whole station stops collecting.
 *
 * WHAT HAPPENS ON PARTIAL FAILURE. Nothing. Every point is checked before the
 * transaction opens - exists and in scope (404 `point_not_found`), on a
 * building if equipment is being set (409 `station_unassigned`), on the
 * equipment's building (409 `equipment_other_building`) - and the first
 * refusal fails the whole request with the count in the message and zero rows
 * written. The reasoning is in bulkClassifyPoints: a selection is one
 * statement about N points, and a half-applied statement is harder to recover
 * from than a refused one.
 *
 * WHAT COMES BACK. `{ points, roleChanged, equipmentChanged, unchanged }`.
 * Points that already held every value sent are `unchanged`: not a failure,
 * and no audit row, exactly as the single-point route treats a no-op.
 *
 * A row per point in the audit log, with `viaBulk: true` and the selection
 * size, never one row for the selection.
 *
 * POST, not PATCH: the resource is a selection that exists only in this
 * request, and the path is `points/bulk` so Next's static segment wins over
 * `points/[pointId]`.
 */
export async function POST(request: Request) {
  return withBasSettings(
    ROUTE,
    async (viewer, input: BulkClassifyInput) =>
      settingsResult(
        () => bulkClassifyPoints(viewer, input),
        (result) => ok(result),
      ),
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = bulkClassifySchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues[0]?.message };
      }
      return { ok: true, data: parsed.data };
    },
  );
}

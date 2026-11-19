import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import { runAssignmentNow } from "@/lib/modules/bas/settings-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/stations/[stationId]/auto-assign";

/**
 * "Run assignment now" (2026-11-19): the scheduler's automatic assignment
 * pass, for this one station, without waiting for the next pass.
 *
 * WHAT IT ACCEPTS. Nothing. The pass decides everything from the database -
 * which points are candidates, which suggestions are high-confidence, which
 * equipment to create - exactly as the scheduler's does, through the same
 * function (lib/modules/bas/auto-assign.ts). A request body is ignored.
 *
 * WHAT IT NEVER DOES. Write a point a person classified (assignment_source
 * 'manual'), write a half that already has a value, or apply a medium
 * suggestion. Each is enforced in the UPDATE.
 *
 * WHAT COMES BACK. `{ outcome, candidates, pointsAssigned, roleAssigned,
 * equipmentAttached, equipmentCreated, needDecision }`.
 *
 * Audited as one `bas.auto_assignment_ran` row with the viewer as actor,
 * every press, and a `bas.point_auto_assigned` row per point written.
 * Module admins only, like every settings route.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ stationId: string }> },
) {
  return withBasSettings(ROUTE, async (viewer) => {
    const { stationId } = await params;
    return settingsResult(
      () => runAssignmentNow(viewer, stationId),
      (result) => ok(result),
    );
  });
}

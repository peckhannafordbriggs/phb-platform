import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import {
  deleteBasEquipment,
  updateBasEquipment,
} from "@/lib/modules/bas/settings-service";
import {
  updateEquipmentSchema,
  type UpdateEquipmentInput,
} from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/equipment/[equipmentId]";

/**
 * Edit equipment (B8.5): name, type, parent, notes - only the fields sent.
 * Reparenting after creation is the edit the phase needed: the office VAVs
 * were created first and pointed at the RTU afterwards.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ equipmentId: string }> },
) {
  return withBasSettings(
    ROUTE,
    async (viewer, input: UpdateEquipmentInput) => {
      const { equipmentId } = await params;
      return settingsResult(
        () => updateBasEquipment(viewer, equipmentId, input),
        (result) => ok(result),
      );
    },
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = updateEquipmentSchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues[0]?.message };
      }
      return { ok: true, data: parsed.data };
    },
  );
}

/**
 * Delete equipment that nothing depends on. Refused with 409
 * `equipment_in_use` while points are attached or equipment sits under it;
 * never cascaded, because a cascade here would silently detach points from
 * the equipment that makes their setpoint pairings work.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ equipmentId: string }> },
) {
  return withBasSettings(ROUTE, async (viewer) => {
    const { equipmentId } = await params;
    return settingsResult(
      () => deleteBasEquipment(viewer, equipmentId),
      (result) => ok(result),
    );
  });
}

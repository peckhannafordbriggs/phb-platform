import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import { createBasEquipment } from "@/lib/modules/bas/settings-service";
import {
  createEquipmentSchema,
  type CreateEquipmentInput,
} from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/equipment";

/**
 * Create equipment on a building (B8.5): a name, a type from the vocabulary,
 * an optional parent on the same building and optional notes. The inline
 * "New equipment" form on the Points list posts here, then attaches the point
 * with a separate PATCH - two requests, two audit rows, because creating an
 * RTU and attaching a point to it are two things a person did.
 *
 * Answers `{ equipmentId }` with 201, like the other creates.
 */
export async function POST(request: Request) {
  return withBasSettings(
    ROUTE,
    async (viewer, input: CreateEquipmentInput) =>
      settingsResult(
        () => createBasEquipment(viewer, input),
        (created) => ok(created, 201),
      ),
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = createEquipmentSchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues[0]?.message };
      }
      return { ok: true, data: parsed.data };
    },
  );
}

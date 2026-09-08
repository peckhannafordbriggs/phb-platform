import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import {
  deleteBasStation,
  updateBasStation,
} from "@/lib/modules/bas/settings-service";
import {
  updateStationSchema,
  type UpdateStationInput,
} from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/stations/[stationId]";

/**
 * Edit a station. Not its credential - that is the /credential route, because a
 * payload carrying a secret should not share a schema with one that does not.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ stationId: string }> },
) {
  return withBasSettings(
    ROUTE,
    async (viewer, input: UpdateStationInput) => {
      const { stationId } = await params;
      return settingsResult(
        () => updateBasStation(viewer, stationId, input),
        (result) => ok(result),
      );
    },
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = updateStationSchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues[0]?.message };
      }
      return { ok: true, data: parsed.data };
    },
  );
}

/**
 * Delete a station, but only one with nothing hanging off it.
 *
 * Refused when it has points, child stations, or recorded collector runs. Its
 * readings exist nowhere else in the world - the station overwrote them about
 * 42 hours after recording them - so this offers "mark it inactive" instead,
 * which is what someone decommissioning a JACE actually wants.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ stationId: string }> },
) {
  return withBasSettings(ROUTE, async (viewer) => {
    const { stationId } = await params;
    return settingsResult(
      () => deleteBasStation(viewer, stationId),
      (result) => ok(result),
    );
  });
}

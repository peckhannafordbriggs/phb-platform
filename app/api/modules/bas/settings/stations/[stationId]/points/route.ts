import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import { getStationPoints } from "@/lib/modules/bas/settings-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/stations/[stationId]/points";

/**
 * One station's points, for the Points level of the Settings tree (B8.2).
 *
 * Read-only. There is no PATCH here and none is planned on this path: labels
 * and visibility are B8.4 and B8.3, and they will edit one point, not a
 * station's list.
 *
 * Loaded when a station is expanded, not with the tree - 26 points today, 600
 * per project later. The count on the station row does not come from this
 * route; it is a direct count in the tree query, so the row is right whether or
 * not anyone expands it.
 *
 * `withBasSettings`, like every route under settings/**: module-admin grant or
 * 404. A station outside the viewer's scope is also 404, through
 * `station_not_found`, so a station that exists and is not theirs reads the
 * same as one that does not exist.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ stationId: string }> },
) {
  return withBasSettings(ROUTE, async (viewer) => {
    const { stationId } = await params;
    return settingsResult(
      () => getStationPoints(viewer, stationId),
      (list) => ok(list),
    );
  });
}

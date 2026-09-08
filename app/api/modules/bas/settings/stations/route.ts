import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import { createBasStation } from "@/lib/modules/bas/settings-service";
import {
  createStationSchema,
  type CreateStationInput,
} from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/stations";

/**
 * Register a station, optionally with its Niagara login in the same request.
 *
 * THIS ROUTE RECEIVES A PASSWORD AND NEVER RETURNS ONE. The response is
 * `{ stationId }` and nothing else - no echo of the submitted body, which is
 * the usual way a secret ends up in a response by accident.
 *
 * There is deliberately no "test connection" here or anywhere else. A test
 * would open a socket from wherever the platform runs; that works on a laptop
 * on the building network and stops working forever once this is in Azure,
 * which cannot reach the building network and must not be able to. Whether a
 * station is really collecting is answered from bas_ingest_runs and
 * bas_sync_checkpoints in the tree, which is true from anywhere.
 */
export async function POST(request: Request) {
  return withBasSettings(
    ROUTE,
    async (viewer, input: CreateStationInput) =>
      settingsResult(
        () => createBasStation(viewer, input),
        (created) => ok(created, 201),
      ),
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = createStationSchema.safeParse(body);
      if (!parsed.success) {
        // The issue's MESSAGE only. Zod can include the received value in some
        // issue shapes, and this body may carry a password.
        return { ok: false, message: parsed.error.issues[0]?.message };
      }
      return { ok: true, data: parsed.data };
    },
  );
}

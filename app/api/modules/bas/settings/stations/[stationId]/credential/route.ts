import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import {
  clearBasStationCredential,
  setBasStationCredential,
} from "@/lib/modules/bas/settings-service";
import {
  setCredentialSchema,
  type SetCredentialInput,
} from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/stations/[stationId]/credential";

/**
 * The Niagara login for one station. WRITE-ONLY.
 *
 * There is no GET here, and that is the design rather than an omission. The
 * username, whether a password is set, and when it last moved are on the
 * station in the settings tree; the password itself has no read path anywhere
 * in the platform. The only code that decrypts is the collector, which has the
 * key and its own connection.
 *
 * PUT and not POST: setting a password is idempotent - the second identical
 * request leaves the same state - and "replace the login" is the only operation
 * this path has. DELETE removes it.
 *
 * The response is `{ passwordSet: true }`. It deliberately does not echo the
 * username, because echoing a submitted body is how the next field added to
 * this payload ends up in a response.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ stationId: string }> },
) {
  return withBasSettings(
    ROUTE,
    async (viewer, input: SetCredentialInput) => {
      const { stationId } = await params;
      return settingsResult(
        () => setBasStationCredential(viewer, stationId, input),
        (result) => ok(result),
      );
    },
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = setCredentialSchema.safeParse(body);
      if (!parsed.success) {
        // The MESSAGE only, never the issue object. Zod issues can carry the
        // received value, and the received value here is a password.
        return { ok: false, message: parsed.error.issues[0]?.message };
      }
      return { ok: true, data: parsed.data };
    },
  );
}

/** Forget the stored login. The station stays registered. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ stationId: string }> },
) {
  return withBasSettings(ROUTE, async (viewer) => {
    const { stationId } = await params;
    return settingsResult(
      () => clearBasStationCredential(viewer, stationId),
      (result) => ok(result),
    );
  });
}

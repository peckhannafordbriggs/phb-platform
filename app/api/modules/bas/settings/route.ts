import { getBasSettingsTree } from "@/lib/modules/bas/settings-service";
import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsQuerySchema } from "@/lib/validation/bas-settings";
import type { BasSettingsFilters } from "@/lib/modules/bas/types";

// Prisma needs Node, and every route under app/api/modules/* is database-backed.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings";

/**
 * The Settings tree: organisation -> project -> building -> station.
 *
 * `withBasSettings`, not `withBas`. The caller needs the BAS module grant AND
 * that grant's `is_module_admin` flag; anything less is 404, not 403, because
 * the platform does not confirm to someone who cannot use it that a module's
 * administrative surface exists. The wrapper is what calls the guard - this
 * handler has no way to reach the viewer without going through it.
 *
 * The filters (B7.6) are read from the query string and applied IN SQL by the
 * service. They are not parsed into `input` through the wrapper's `parse` hook
 * because an unrecognised value here is not a validation failure - the schema
 * catches it and falls back to unfiltered, so a stale bookmark renders the
 * screen rather than a 422.
 */
export async function GET(request: Request) {
  return withBasSettings(ROUTE, async (viewer) => {
    const params = new URL(request.url).searchParams;
    const parsed = settingsQuerySchema.parse({
      q: params.get("q") ?? undefined,
      mode: params.get("mode"),
      state: params.get("state"),
      cred: params.get("cred"),
    });

    const filters: BasSettingsFilters = {
      q: parsed.q,
      mode: parsed.mode,
      state: parsed.state,
      credential: parsed.cred,
    };

    return ok(await getBasSettingsTree(viewer, filters));
  });
}

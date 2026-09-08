import { getBasSettingsTree } from "@/lib/modules/bas/settings-service";
import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";

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
 * GET only. B7.2 is read-only; the create and edit routes are B7.3 and B7.4,
 * and a POST added here before then would be an unguarded write behind a guard
 * that has only ever been tested for reads.
 */
export async function GET() {
  return withBasSettings(ROUTE, async (viewer) =>
    ok(await getBasSettingsTree(viewer)),
  );
}

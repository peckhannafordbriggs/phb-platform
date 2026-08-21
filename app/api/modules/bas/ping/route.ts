import { ok, withBas } from "@/lib/modules/bas/route-helpers";

// Prisma needs Node, and every route under app/api/modules/* is database-backed.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/ping";

/**
 * Exists to prove the guard works, and stays afterwards as the first thing to
 * check when a BAS screen shows nothing.
 *
 * It reads no BAS rows. What it demonstrates is the wrapper: 401 unauthenticated,
 * 404 without a grant, and `bas_unavailable` when the bas_* tables are not in
 * this database. Note that it never calls requireModuleAccess itself - withBas
 * does, which is the point of the wrapper.
 */
export async function GET() {
  return withBas(ROUTE, async () => ok({ ok: true }));
}

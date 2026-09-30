import { getDashboard } from "@/lib/modules/bas/service";
import { ok, withBas } from "@/lib/modules/bas/route-helpers";

// Prisma needs Node, and every route under app/api/modules/* is database-backed.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/dashboard";

/**
 * Every project card, in one response.
 *
 * No inputs: the Projects tab is not filtered, it IS the list. One route rather
 * than one per card for the same reason Collection Health is one route - the
 * screen polls, and N cards fetched separately would be N authorization
 * checks and N different `now()` values per refresh, so two cards could
 * disagree about how old "now" is. `getDashboard` reads them all inside one
 * transaction.
 */
export async function GET() {
  return withBas(ROUTE, async (viewer) => ok(await getDashboard(viewer)));
}

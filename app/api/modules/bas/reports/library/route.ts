import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { listLibraryQuestions } from "@/lib/modules/bas/reports/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/library";

/**
 * The shared question library, read-only. Every BAS user sees the whole of
 * it, disabled rows included and marked, because a report may still carry a
 * question that has since been turned off and the screen has to be able to
 * say what it is. Editing it (planner-kind rows, by module admins) is a later
 * phase.
 */
export async function GET() {
  return withBas(ROUTE, async () => ok(await listLibraryQuestions()));
}

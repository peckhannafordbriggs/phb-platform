import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { parseBody } from "@/lib/modules/bas/reports/parse";
import { listLibraryQuestions, promotePersonalQuestion } from "@/lib/modules/bas/reports/service";
import { promoteQuestionSchema, type PromoteQuestionInput } from "@/lib/validation/bas-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/library";

/**
 * The shared question library. Every BAS user sees the whole of it,
 * disabled rows included and marked, because a report may still carry a
 * question that has since been turned off and the screen has to be able to
 * say what it is.
 */
export async function GET() {
  return withBas(ROUTE, async () => ok(await listLibraryQuestions()));
}

/**
 * Promote one of the caller's saved questions into the shared library as a
 * planner-kind question (Reports, Phase 6). A BAS module admin only, which
 * the service decides (`admin_required`, 403) - the library is read by
 * everyone, so the route cannot be admin-only. Audited.
 */
export async function POST(request: Request) {
  return withBas(
    ROUTE,
    async (viewer, input: PromoteQuestionInput) =>
      reportsResult(
        () => promotePersonalQuestion(viewer, input),
        (created) => ok(created, 201),
      ),
    parseBody(request, promoteQuestionSchema),
  );
}

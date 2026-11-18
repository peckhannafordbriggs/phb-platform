import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { parseBody } from "@/lib/modules/bas/reports/parse";
import { createPersonalQuestion, listPersonalQuestions } from "@/lib/modules/bas/reports/service";
import { personalQuestionSchema, type PersonalQuestionInput } from "@/lib/validation/bas-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/personal";

/** The caller's own saved questions. Nobody else's, whatever their grant. */
export async function GET() {
  return withBas(ROUTE, async (viewer) => ok(await listPersonalQuestions(viewer)));
}

export async function POST(request: Request) {
  return withBas(
    ROUTE,
    async (viewer, input: PersonalQuestionInput) =>
      reportsResult(
        () => createPersonalQuestion(viewer, input.text),
        (created) => ok(created, 201),
      ),
    parseBody(request, personalQuestionSchema),
  );
}

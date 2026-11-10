import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { parseBody } from "@/lib/modules/bas/reports/parse";
import { deletePersonalQuestion, updatePersonalQuestion } from "@/lib/modules/bas/reports/service";
import { personalQuestionSchema, type PersonalQuestionInput } from "@/lib/validation/bas-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/personal/[questionId]";

/** Edit the text of one of the caller's own questions. Reports using it see the new text. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ questionId: string }> },
) {
  return withBas(
    ROUTE,
    async (viewer, input: PersonalQuestionInput) => {
      const { questionId } = await params;
      return reportsResult(
        () => updatePersonalQuestion(viewer, questionId, input.text),
        (result) => ok(result),
      );
    },
    parseBody(request, personalQuestionSchema),
  );
}

/** Delete one of the caller's own questions - refused while a report still uses it. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ questionId: string }> },
) {
  return withBas(ROUTE, async (viewer) => {
    const { questionId } = await params;
    return reportsResult(
      () => deletePersonalQuestion(viewer, questionId),
      (result) => ok(result),
    );
  });
}

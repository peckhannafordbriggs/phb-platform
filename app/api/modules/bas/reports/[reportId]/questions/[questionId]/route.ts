import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { removeReportQuestion } from "@/lib/modules/bas/reports/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/[reportId]/questions/[questionId]";

/** Remove one question. The rest close up; a preset report refuses. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ reportId: string; questionId: string }> },
) {
  return withBas(ROUTE, async (viewer) => {
    const { reportId, questionId } = await params;
    return reportsResult(
      () => removeReportQuestion(viewer, reportId, questionId),
      (result) => ok(result),
    );
  });
}

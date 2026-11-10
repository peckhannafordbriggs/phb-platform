import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { parseBody } from "@/lib/modules/bas/reports/parse";
import { addReportQuestion, reorderReportQuestions } from "@/lib/modules/bas/reports/service";
import {
  addReportQuestionSchema,
  reorderReportQuestionsSchema,
  type AddReportQuestionInput,
  type ReorderReportQuestionsInput,
} from "@/lib/validation/bas-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/[reportId]/questions";

/**
 * Append one question - from the shared library, from the caller's personal
 * library, or typed. Refused on a preset report (409 preset_locked): the
 * preset's questions are the preset's.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ reportId: string }> },
) {
  return withBas(
    ROUTE,
    async (viewer, input: AddReportQuestionInput) => {
      const { reportId } = await params;
      return reportsResult(
        () => addReportQuestion(viewer, reportId, input),
        (created) => ok(created, 201),
      );
    },
    parseBody(request, addReportQuestionSchema),
  );
}

/** The whole order, as every question id exactly once. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ reportId: string }> },
) {
  return withBas(
    ROUTE,
    async (viewer, input: ReorderReportQuestionsInput) => {
      const { reportId } = await params;
      return reportsResult(
        () => reorderReportQuestions(viewer, reportId, input.questionIds),
        (result) => ok(result),
      );
    },
    parseBody(request, reorderReportQuestionsSchema),
  );
}

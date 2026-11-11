import { z } from "zod";
import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { fail, notFound, ok, serverError, validationFailed } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import { KNOWLEDGE_BASE_MODULE_KEY } from "@/lib/modules/knowledge-base/constants";
import { KB_REPORT_COMMENT_MAX, KbReportError, reportAnswer } from "@/lib/modules/knowledge-base/reports";
import { KB_REPORT_REASONS } from "@/lib/modules/knowledge-base/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IdParams = { params: Promise<{ id: string }> };

const body = z
  .object({
    reason: z.enum(KB_REPORT_REASONS),
    citationN: z.number().int().min(1).nullish(),
    comment: z.string().max(KB_REPORT_COMMENT_MAX).nullish(),
  })
  .strict();

/**
 * POST /api/modules/knowledge-base/questions/<question id>/report
 *   { "reason": "wrong_fact", "citationN"?: 2, "comment"?: "..." }
 *
 * Reports an answer as wrong (lib/modules/knowledge-base/reports.ts). Anyone
 * with the Knowledge Base grant, on anyone's answer. Reporting again while the
 * first report is open updates it.
 */
export async function POST(request: Request, { params }: IdParams) {
  const access = await requireModuleAccess(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFailed("Pick what is wrong. A comment can be up to 2,000 characters.");
  try {
    return ok(
      await reportAnswer({
        questionId: id,
        reporterId: access.viewer.id,
        reason: parsed.data.reason,
        citationN: parsed.data.citationN ?? null,
        comment: parsed.data.comment ?? null,
      }),
    );
  } catch (error) {
    if (error instanceof KbReportError) {
      return error.code === "question_not_found" ? notFound(error.message) : fail(422, error.code, error.message);
    }
    logUnexpected("kb.report_failed", error, { employeeId: access.viewer.id });
    return serverError();
  }
}

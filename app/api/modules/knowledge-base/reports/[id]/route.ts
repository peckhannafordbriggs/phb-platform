import { z } from "zod";
import { denialResponse, requireModuleAdmin } from "@/lib/authz";
import { fail, notFound, ok, serverError, validationFailed } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import { KNOWLEDGE_BASE_MODULE_KEY } from "@/lib/modules/knowledge-base/constants";
import { KB_REPORT_NOTE_MAX, KbReportError, closeReport } from "@/lib/modules/knowledge-base/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IdParams = { params: Promise<{ id: string }> };

const body = z
  .object({
    status: z.enum(["resolved", "dismissed"]),
    note: z.string().trim().min(1).max(KB_REPORT_NOTE_MAX),
  })
  .strict();

/**
 * POST /api/modules/knowledge-base/reports/<report id>
 *   { "status": "resolved" | "dismissed", "note": "what was found" }
 *
 * Closes an open report. Knowledge Base module admins only; 404 otherwise.
 * 409 when someone else closed it first.
 */
export async function POST(request: Request, { params }: IdParams) {
  const access = await requireModuleAdmin(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound();

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFailed("Choose resolved or dismissed, and write a note saying what you found.");
  try {
    await closeReport({ reportId: id, adminId: access.viewer.id, status: parsed.data.status, note: parsed.data.note });
    return ok({ id, status: parsed.data.status });
  } catch (error) {
    if (error instanceof KbReportError) {
      return error.code === "report_not_found" ? notFound(error.message) : fail(409, error.code, error.message);
    }
    logUnexpected("kb.report_close_failed", error, { employeeId: access.viewer.id });
    return serverError();
  }
}

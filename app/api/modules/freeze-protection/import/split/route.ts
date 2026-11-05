import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { fail, ok, serverError } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { MAX_PDF_BYTES, PdfReadError, extractPdfPages } from "@/lib/modules/freeze-protection/import/pdf";
import { splitSchedules } from "@/lib/modules/freeze-protection/import/split";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/freeze-protection/import/split";

/**
 * Step 1 of the schedule import: the PDF in, the schedules on it out, as text.
 * No model call and nothing stored: the file is read in memory and dropped,
 * and the browser sends each schedule back to /import/analyze in turn.
 */
export async function POST(request: Request) {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) return fail(422, "invalid", "Choose the equipment schedule PDF.");
  if (file.size > MAX_PDF_BYTES) {
    return fail(413, "too_large", `That file is ${(file.size / 1048576).toFixed(0)} MB. Upload only the schedule sheets (40 MB at most).`);
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isPdf(bytes)) return fail(422, "invalid", "That file is not a PDF.");
    const pages = await extractPdfPages(bytes);
    const schedules = splitSchedules(pages);
    if (schedules.length === 0) {
      return fail(422, "no_schedules", "No schedules were found in that PDF. Each schedule needs a title such as \"FAN SCHEDULE\" above its table.");
    }
    return ok({ fileName: file.name, pages: pages.length, schedules });
  } catch (error) {
    if (error instanceof PdfReadError) return fail(422, error.code, error.message);
    logUnexpected("fp.import_split_failed", error, { route: ROUTE, employeeId: access.viewer.id });
    return serverError();
  }
}

/** "%PDF-" within the first kilobyte, as readers allow. */
function isPdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

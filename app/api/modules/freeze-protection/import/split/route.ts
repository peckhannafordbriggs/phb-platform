import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { fail, ok, serverError } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { parseForm } from "@/lib/modules/freeze-protection/import/form";
import { MAX_PDF_BYTES, PdfReadError, readPdf } from "@/lib/modules/freeze-protection/import/pdf";
import { splitSchedules } from "@/lib/modules/freeze-protection/import/split";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/freeze-protection/import/split";

/**
 * Step 1 of every import: the PDF in, what kind it is and what is on it out.
 * No model call and nothing stored: the file is read in memory and dropped.
 *
 * - `kind: "form"`: the filled verification form (its hidden marker field),
 *   with its rows parsed. The browser sends them to POST /import/form.
 * - `kind: "schedule"`: a drawing set, cut into schedules as text. The browser
 *   sends each to /import/analyze, then the kept units to /import/commit.
 *
 * The path keeps its first name, "split", so nothing that already calls it moves.
 */
export async function POST(request: Request) {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) return fail(422, "invalid", "Choose the equipment schedule PDF or a filled freeze protection form.");
  if (file.size > MAX_PDF_BYTES) {
    return fail(413, "too_large", `That file is ${(file.size / 1048576).toFixed(0)} MB. Upload only the schedule sheets (40 MB at most).`);
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isPdf(bytes)) return fail(422, "invalid", "That file is not a PDF.");
    const contents = await readPdf(bytes);

    if (contents.kind === "form") {
      const parsed = parseForm(contents.fields);
      if (parsed.rows.length === 0) {
        const why = parsed.problems.length > 0 ? ` ${parsed.problems.join(" ")}` : "";
        return fail(
          422,
          "empty_form",
          `That form has no units filled in. Fill in at least one name, save the PDF (some viewers need "Save as"), and upload it again.${why}`,
        );
      }
      return ok({ kind: "form" as const, fileName: file.name, form: parsed });
    }

    const schedules = splitSchedules(contents.pages);
    if (schedules.length === 0) {
      return fail(422, "no_schedules", "No schedules were found in that PDF. Each schedule needs a title such as \"FAN SCHEDULE\" above its table.");
    }
    return ok({ kind: "schedule" as const, fileName: file.name, pages: contents.pages.length, schedules });
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

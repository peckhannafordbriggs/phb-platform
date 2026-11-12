import { readFile } from "node:fs/promises";
import path from "node:path";
import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { serverError } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { importForm } from "@/lib/modules/freeze-protection/import/form-commit";
import { importFormSchema } from "@/lib/modules/freeze-protection/schemas";
import { handleWrite } from "../../handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/freeze-protection/import/form";

/**
 * The blank verification form. Served here, behind the grant, rather than from
 * public/, so the file never confirms the module exists to someone without it.
 * next.config.ts `outputFileTracingIncludes` copies it into the standalone build;
 * scripts/fp-build-form.py makes it.
 */
const FORM_FILE = path.join(process.cwd(), "lib/modules/freeze-protection/import/assets/fp-verification-form.pdf");

export async function GET() {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);
  try {
    const bytes = await readFile(FORM_FILE);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="freeze-protection-verification-form.pdf"',
        "cache-control": "private, max-age=3600",
      },
    });
  } catch (error) {
    logUnexpected("fp.form_download_failed", error, { route: ROUTE, employeeId: access.viewer.id });
    return serverError();
  }
}

/** A filled form's rows (parsed by /import/split), saved in one transaction: new units added, blanks filled, differences reported. */
export async function POST(request: Request) {
  return handleWrite(request, {
    route: ROUTE,
    event: "fp.form_import_failed",
    schema: importFormSchema,
    run: (actorId, body) => importForm(actorId, body),
    status: 201,
  });
}

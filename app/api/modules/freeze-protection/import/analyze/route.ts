import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { fail, ok, serverError, validationFailed } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import { readFreezeProtectionAnthropicEnv } from "@/lib/modules/freeze-protection/anthropic-env";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { AnalyzeError, createScheduleAnalyzer } from "@/lib/modules/freeze-protection/import/analyze";
import { checkSchedule } from "@/lib/modules/freeze-protection/import/validate";
import { analyzeScheduleSchema } from "@/lib/modules/freeze-protection/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/freeze-protection/import/analyze";

const STATUS: Record<AnalyzeError["code"], number> = {
  unavailable: 502,
  unparseable: 502,
  refused: 422,
  too_long: 422,
};

/**
 * Step 2 of the schedule import, once per schedule: the model reads it, then
 * the deterministic checks run (validate.ts). One schedule per request keeps
 * each request well inside the platform's request time limit and lets the
 * browser show progress. Nothing is written.
 */
export async function POST(request: Request) {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  const parsed = analyzeScheduleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFailed();

  const env = readFreezeProtectionAnthropicEnv();
  if (!env.present) {
    return fail(503, "not_configured", `Schedule import is not set up: ${env.missing.join(", ")} is missing. Add equipment by hand, or ask the platform owner to add the key.`);
  }

  try {
    const raw = await createScheduleAnalyzer(env.values.apiKey).analyze(parsed.data);
    return ok(checkSchedule(parsed.data, raw));
  } catch (error) {
    if (error instanceof AnalyzeError) {
      if (error.code !== "too_long" && error.code !== "refused") {
        logUnexpected("fp.import_analyze_failed", error, { route: ROUTE, employeeId: access.viewer.id });
      }
      return fail(STATUS[error.code], error.code, error.message);
    }
    logUnexpected("fp.import_analyze_failed", error, { route: ROUTE, employeeId: access.viewer.id });
    return serverError();
  }
}

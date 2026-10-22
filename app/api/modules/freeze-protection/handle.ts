import type { z } from "zod";
import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { fail, ok, serverError, validationFailed } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { FP_ERROR_STATUS, type FpResult } from "@/lib/modules/freeze-protection/result";

/**
 * The one shape every Freeze Protection write route has, so none of them can
 * skip a step: the grant check (anyone granted can do everything, decision
 * 2026-10-22; a missing grant is a 404 via denialResponse), strict body
 * validation (422), the service call, and the service's own refusal mapped
 * through FP_ERROR_STATUS. Not a route: Next only serves route.ts.
 */
export async function handleWrite<S extends z.ZodType, T>(
  request: Request,
  options: {
    route: string;
    event: string;
    schema: S | null;
    run: (actorId: string, body: z.infer<S>) => Promise<FpResult<T>>;
    status?: number;
  },
) {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  let body: z.infer<S> = undefined as z.infer<S>;
  if (options.schema !== null) {
    const parsed = options.schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationFailed();
    body = parsed.data;
  }

  try {
    const result = await options.run(access.viewer.id, body);
    if (!result.ok) return fail(FP_ERROR_STATUS[result.code], result.code, result.message);
    return ok(result.data, options.status);
  } catch (error) {
    logUnexpected(options.event, error, { route: options.route, employeeId: access.viewer.id });
    return serverError();
  }
}

export type IdParams = { params: Promise<{ id: string }> };

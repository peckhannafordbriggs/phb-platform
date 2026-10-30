import { z } from "zod";
import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { ok, serverError, validationFailed } from "@/lib/api/response";
import { logger, logUnexpected } from "@/lib/logger";
import { KNOWLEDGE_BASE_MODULE_KEY } from "@/lib/modules/knowledge-base/constants";
import { searchPassages } from "@/lib/modules/knowledge-base/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/knowledge-base/search";

const params = z.object({
  q: z.string().trim().min(1).max(300),
  project: z.array(z.uuid()).max(20),
});

/**
 * GET /api/modules/knowledge-base/search?q=<words>[&project=<id>...]
 *
 * Keyword search over indexed passages (lib/modules/knowledge-base/search.ts).
 * Anyone with the Knowledge Base grant; 404 otherwise. Read only: nothing is
 * written, not even history - history is for answers, which come later.
 */
export async function GET(request: Request) {
  const access = await requireModuleAccess(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  const url = new URL(request.url);
  const parsed = params.safeParse({ q: url.searchParams.get("q") ?? "", project: url.searchParams.getAll("project") });
  if (!parsed.success) return validationFailed("Type up to 300 characters to search for.");

  const started = Date.now();
  try {
    const result = await searchPassages({ query: parsed.data.q, projectIds: parsed.data.project });
    logger.info("kb.searched", {
      route: ROUTE,
      employeeId: access.viewer.id,
      moduleKey: KNOWLEDGE_BASE_MODULE_KEY,
      count: result.hits.length,
      durationMs: Date.now() - started,
    });
    return ok(result);
  } catch (error) {
    logUnexpected("kb.search_failed", error, { route: ROUTE, employeeId: access.viewer.id });
    return serverError();
  }
}

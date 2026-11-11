import { z } from "zod";
import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { fail, notFound, ok, serverError, validationFailed } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import { KbAskError, askQuestion } from "@/lib/modules/knowledge-base/ask";
import { KNOWLEDGE_BASE_MODULE_KEY } from "@/lib/modules/knowledge-base/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Search, re-sort and an answer: well inside a minute, never the platform default.
export const maxDuration = 120;

const ROUTE = "/api/modules/knowledge-base/ask";

const body = z
  .object({
    question: z.string().trim().min(1).max(500),
    conversationId: z.uuid().nullish(),
    projectIds: z.array(z.uuid()).max(20).optional(),
  })
  .strict();

/**
 * POST /api/modules/knowledge-base/ask
 *   { "question": "...", "conversationId"?: "<id>", "projectIds"?: ["<id>"] }
 *
 * Answers a question from the indexed documents, citing each source, and
 * saves it to the shared history (lib/modules/knowledge-base/ask.ts). With
 * `conversationId`, a follow-up in that conversation - only its starter's.
 * Anyone with the Knowledge Base grant; 404 otherwise.
 *
 *   200  { asked, search }   the saved question and the search behind it
 *   404  conversation_not_found
 *   409  not_your_conversation
 *   422  validation_failed
 *   429  rate_limited
 *   502  answer_failed        Claude did not answer; nothing was saved
 *   503  not_configured       no KB_ANTHROPIC_API_KEY here; search still works
 */
export async function POST(request: Request) {
  const access = await requireModuleAccess(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFailed("Type a question of up to 500 characters.");

  try {
    return ok(
      await askQuestion({
        employeeId: access.viewer.id,
        question: parsed.data.question,
        conversationId: parsed.data.conversationId ?? null,
        ...(parsed.data.projectIds ? { projectIds: parsed.data.projectIds } : {}),
      }),
    );
  } catch (error) {
    if (error instanceof KbAskError) {
      switch (error.code) {
        case "conversation_not_found":
          return notFound(error.message);
        case "not_your_conversation":
          return fail(409, error.code, error.message);
        case "rate_limited":
          return fail(429, error.code, error.message);
        case "answer_failed":
          return fail(502, error.code, error.message);
        case "not_configured":
          return fail(503, error.code, error.message);
      }
    }
    logUnexpected("kb.ask_failed", error, { route: ROUTE, employeeId: access.viewer.id });
    return serverError();
  }
}

import { z } from "zod";
import { fail } from "@/lib/api/response";
import { readAnalyzeEnv } from "@/lib/modules/bas/analyze/env";
import { createAnthropicPlanner } from "@/lib/modules/bas/analyze/planner";
import {
  MAX_QUESTION_LENGTH,
  RateLimited,
  analyzeQuestion,
} from "@/lib/modules/bas/analyze/service";
import { ok, withBas } from "@/lib/modules/bas/route-helpers";

// The analyze pool is `pg`, the audit row is Prisma, the planner is the SDK.
// All three need Node.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Two model calls and a fifteen-second database ceiling. Vercel-style limits
// do not apply on Container Apps, but stating the intent keeps a future host
// from cutting a slow answer off silently.
export const maxDuration = 150;

const ROUTE = "/api/modules/bas/analyze";

const BodySchema = z.object({
  question: z.string().trim().min(3).max(MAX_QUESTION_LENGTH),
});

/**
 * GET: is Analyze configured, and if not, which variable is missing.
 *
 * Named so the screen can say "not configured" before anyone types, rather
 * than after. Variable NAMES are returned; values never are.
 */
export async function GET() {
  return withBas(ROUTE, async () => {
    const env = readAnalyzeEnv();
    return ok(
      env.present
        ? { configured: true, missing: [] }
        : { configured: false, missing: env.missing },
    );
  });
}

/**
 * POST: one question, one AnalyzeResult.
 *
 * The result union is returned as-is under `data`, including the honest
 * outcomes - `not_configured`, `clarify`, `cannot_answer`, `no_data` are all
 * 200s, because each is a complete, correct answer to what was asked. The
 * only non-200s are the platform's own: 401/404 from the guard, 422 for a
 * malformed body, 429 for the rate limit, 500 for a defect.
 */
export async function POST(request: Request) {
  return withBas(
    ROUTE,
    async (viewer, input: { question: string }) => {
      const env = readAnalyzeEnv();
      if (!env.present) {
        return ok({ kind: "not_configured", missing: env.missing });
      }

      try {
        const result = await analyzeQuestion(viewer, input.question, {
          planner: createAnthropicPlanner(env.values.apiKey),
        });
        return ok(result);
      } catch (error) {
        if (error instanceof RateLimited) {
          return fail(429, "rate_limited", error.message);
        }
        throw error;
      }
    },
    async () => {
      const body = (await request.json().catch(() => null)) as unknown;
      const parsed = BodySchema.safeParse(body);
      if (!parsed.success) {
        return {
          ok: false,
          message: `Send { question } - between 3 and ${MAX_QUESTION_LENGTH} characters.`,
        };
      }
      return { ok: true, data: parsed.data };
    },
  );
}

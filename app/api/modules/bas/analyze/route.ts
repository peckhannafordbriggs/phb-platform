import { z } from "zod";
import { fail } from "@/lib/api/response";
import { readAnalyzeEnv } from "@/lib/modules/bas/analyze/env";
import { createAnthropicPlanner } from "@/lib/modules/bas/analyze/planner";
import {
  MAX_QUESTION_LENGTH,
  RateLimited,
  analyzeQuestion,
} from "@/lib/modules/bas/analyze/service";
import {
  PRIOR_CELL_MAX_CHARS,
  PRIOR_COLUMNS_MAX,
  PRIOR_ROWS_MAX,
  PRIOR_SQL_MAX_CHARS,
  PRIOR_TEXT_MAX_CHARS,
  PRIOR_TURNS_MAX,
  PRIOR_TURNS_MAX_BYTES,
  type PriorTurn,
} from "@/lib/modules/bas/analyze/types";
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

/**
 * An earlier turn as the browser sends it. Every field is bounded here, and
 * the array as a whole is bounded twice: by count and by serialised size.
 * Nothing in it is trusted downstream - the planner sees it as data and the
 * guard decides every SQL that runs - so these caps are about cost and
 * shape, not safety. `.strict()` so an extra key is 422, not ignored.
 */
const CellSchema = z.union([
  z.string().max(PRIOR_CELL_MAX_CHARS),
  z.number(),
  z.boolean(),
  z.null(),
]);

const PriorTurnSchema = z
  .object({
    id: z.string().min(1).max(64),
    question: z.string().min(1).max(MAX_QUESTION_LENGTH),
    kind: z.enum(["answered", "no_data", "clarify", "cannot_answer", "from_prior"]),
    interpretation: z.string().max(PRIOR_TEXT_MAX_CHARS).nullable(),
    sql: z.string().max(PRIOR_SQL_MAX_CHARS).nullable(),
    answer: z.string().max(PRIOR_TEXT_MAX_CHARS).nullable(),
    columns: z.array(z.string().max(64)).max(PRIOR_COLUMNS_MAX),
    rows: z.array(z.array(CellSchema).max(PRIOR_COLUMNS_MAX)).max(PRIOR_ROWS_MAX),
    rowCount: z.number().int().min(0).nullable(),
    rowsArePartial: z.boolean(),
  })
  .strict();

const BodySchema = z
  .object({
    question: z.string().trim().min(3).max(MAX_QUESTION_LENGTH),
    priorTurns: z.array(PriorTurnSchema).max(PRIOR_TURNS_MAX).optional(),
  })
  .strict();

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
    async (viewer, input: { question: string; priorTurns: PriorTurn[] }) => {
      const env = readAnalyzeEnv();
      if (!env.present) {
        return ok({ kind: "not_configured", missing: env.missing });
      }

      try {
        const result = await analyzeQuestion(
          viewer,
          input.question,
          { planner: createAnthropicPlanner(env.values.apiKey) },
          input.priorTurns,
        );
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
        const aboutTurns = parsed.error.issues.some((issue) => issue.path[0] === "priorTurns");
        return {
          ok: false,
          message: aboutTurns
            ? `priorTurns must be at most ${PRIOR_TURNS_MAX} earlier turns of the documented shape.`
            : `Send { question } - between 3 and ${MAX_QUESTION_LENGTH} characters.`,
        };
      }
      const priorTurns = parsed.data.priorTurns ?? [];
      // The second bound: the whole set, serialised, as the planner will see it.
      if (JSON.stringify(priorTurns).length > PRIOR_TURNS_MAX_BYTES) {
        return {
          ok: false,
          message: `priorTurns is larger than ${PRIOR_TURNS_MAX_BYTES} bytes. Send fewer or smaller turns.`,
        };
      }
      return { ok: true, data: { question: parsed.data.question, priorTurns } };
    },
  );
}

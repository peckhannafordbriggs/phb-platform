import "./load-env";
import { createDbClient } from "./db";
import { readAnalyzeEnv } from "../lib/modules/bas/analyze/env";
import { createAnthropicPlanner } from "../lib/modules/bas/analyze/planner";
import { getAnalyzePool } from "../lib/modules/bas/analyze/pool";
import { analyzeQuestion } from "../lib/modules/bas/analyze/service";
import { QuestionRateLimiter } from "../lib/modules/bas/analyze/rate-limit";
import type { AnalyzeResult, PriorTurn } from "../lib/modules/bas/analyze/types";
import { priorTurnOf } from "../app/(modules)/bas/analyze-thread";

/**
 * Measures what a follow-up costs against the REAL model and the REAL local
 * database, the way scripts/bas-analyze-verify.ts asks its questions.
 *
 *   npm run bas:analyze:followup-latency
 *   npm run bas:analyze:followup-latency -- --first="..." --follow="..." --memory="..."
 *
 * Three questions, timed, each through the same `analyzeQuestion` the route
 * uses: a first question with no earlier turns; a follow-up that carries the
 * first as an earlier turn; and the follow-up's wording asked COLD, with no
 * earlier turns, as the baseline for the same words. Prints the kind of each
 * result, its duration, whether the model read from memory, and what the
 * earlier-turn payload weighed. Writes nothing but the audit row each
 * question always writes, attributed to the first platform admin (or
 * --as=email).
 */

function separateLogLines(): void {
  const original = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && first.startsWith('{"level"')) {
      process.stderr.write(`${first}\n`);
      return;
    }
    original(...args);
  };
}

async function main(): Promise<void> {
  separateLogLines();
  const env = readAnalyzeEnv();
  if (!env.present) throw new Error(`Analyze is not configured: ${env.missing.join(", ")}`);

  const asEmail = process.argv.find((a) => a.startsWith("--as="))?.slice(5) ?? null;
  const db = createDbClient();
  const employee = await db.employee.findFirst({
    where: asEmail === null ? { isPlatformAdmin: true } : { email: asEmail.toLowerCase() },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, firstName: true, lastName: true, isPlatformAdmin: true },
  });
  await db.$disconnect();
  if (employee === null) throw new Error("No employee to attribute the audit rows to. Pass --as=<email>.");
  const viewer = {
    id: employee.id,
    email: employee.email,
    firstName: employee.firstName ?? "",
    lastName: employee.lastName ?? "",
    profileCompleted: true,
    isPlatformAdmin: employee.isPlatformAdmin,
  };

  const planner = createAnthropicPlanner(env.values.apiKey);
  const pool = getAnalyzePool(env.values.askDatabaseUrl);
  const deps = { planner, pool, rateLimiter: new QuestionRateLimiter({ limit: 1_000, windowMs: 1 }) };

  const timed = async (
    label: string,
    question: string,
    prior: PriorTurn[],
  ): Promise<{ result: AnalyzeResult; ms: number }> => {
    const started = Date.now();
    const result = await analyzeQuestion(viewer, question, deps, prior);
    const ms = Date.now() - started;
    const extra =
      result.kind === "from_prior"
        ? ` read from: "${result.source.question}"`
        : result.kind === "answered" || result.kind === "no_data"
          ? ` rows=${result.table.rowCount}`
          : result.kind === "clarify"
            ? ` asks: ${result.question}`
            : result.kind === "cannot_answer"
              ? ` reason: ${result.reason}`
              : "";
    console.log(
      `${label}: ${(ms / 1000).toFixed(1)} s  kind=${result.kind}${"retried" in result && result.retried ? " (retried)" : ""}` +
        `  priorTurns=${prior.length} (${JSON.stringify(prior).length} bytes)${extra}`,
    );
    if ("answer" in result) console.log(`   > ${result.answer.replace(/\s+/g, " ")}`);
    if ("interpretation" in result) console.log(`   reading: ${result.interpretation}`);
    return { result, ms };
  };

  console.log("# Follow-up latency, live model, local database");
  console.log("");

  const arg = (name: string, fallback: string): string =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const firstQuestion = arg("first", "Which points have had no reading in the last 24 hours?");
  const followUp = arg("follow", "Which of those has gone the longest without a reading?");
  const memoryQuestion = arg("memory", "How many points was that, in total?");

  const first = await timed("1. first question", firstQuestion, []);
  const prior = priorTurnOf({
    id: "turn-1",
    askedAt: new Date().toISOString(),
    question: firstQuestion,
    outcome: { kind: "result", result: first.result },
  });
  const earlier = prior === null ? [] : [prior];
  if (prior !== null) {
    console.log(`   earlier turn carries ${prior.rows.length} of ${prior.rowCount ?? "?"} rows (partial: ${prior.rowsArePartial})`);
  }

  const warm = await timed("2. follow-up, with the earlier turn", followUp, earlier);
  const cold = await timed("3. the same words, cold (no earlier turn)", followUp, []);
  const memory = await timed("4. a follow-up the rows already answer", memoryQuestion, earlier);

  console.log("");
  console.log(
    `Follow-up minus first question: ${((warm.ms - first.ms) / 1000).toFixed(1)} s; ` +
      `follow-up minus the same words cold: ${((warm.ms - cold.ms) / 1000).toFixed(1)} s; ` +
      `from-memory candidate: ${(memory.ms / 1000).toFixed(1)} s (${memory.result.kind}).`,
  );

  await pool.end();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

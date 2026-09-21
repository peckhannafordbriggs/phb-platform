import "./load-env";
import { createDbClient } from "./db";
import { readAnalyzeEnv } from "../lib/modules/bas/analyze/env";
import { createAnthropicPlanner } from "../lib/modules/bas/analyze/planner";
import { getAnalyzePool } from "../lib/modules/bas/analyze/pool";
import { getSchemaContext } from "../lib/modules/bas/analyze/schema-context";
import { analyzeQuestion, type Planner } from "../lib/modules/bas/analyze/service";
import { QuestionRateLimiter } from "../lib/modules/bas/analyze/rate-limit";
import type { AnalyzeResult } from "../lib/modules/bas/analyze/types";

/**
 * The manual half of docs/BAS-B5.md's acceptance criteria, run against the
 * REAL local database with the REAL model, and printed as Markdown.
 *
 *   npm run bas:analyze:verify
 *   npm run bas:analyze:verify -- "your own question"
 *
 * It asks the six questions the spec lists (or the one you give it), through
 * the same `analyzeQuestion` the route uses, and prints every result in full:
 * the kind, the model's words, the SQL, the rows, and the provenance the
 * platform computed. It NEVER writes - the pool is the bas_analyze role.
 *
 * What it costs: two model calls per question at claude-opus-5 rates. What it
 * needs: ANTHROPIC_API_KEY and BAS_ASK_DATABASE_URL in .env.local, and it
 * connects as the platform's own DATABASE_URL for nothing at all - the audit
 * row is written through Prisma, which is why DATABASE_URL must still be set.
 *
 * The output is what docs/bas-b5-verification.md is written from. Paste, do
 * not paraphrase: the point of the record is what the model actually said.
 */

const SPEC_QUESTIONS = [
  "What was the average room temperature last week?",
  // Added 2026-09-21 after the gap question exposed a scope fault. A numeric
  // answer over a month that spans recorded outages is where a missing gap
  // warning is DANGEROUS rather than odd: the number looks complete and is
  // not. Named to one building and one kind of point, because the unqualified
  // version was (correctly) answered with a clarifying question and so never
  // reached the number. PHB Steel Place's points carry recorded gaps inside
  // any recent 30-day window. Fails the run if the result has a period with
  // no gap figure, or a time expression with no declared period - see main().
  "What was the average zone temperature at PHB Steel Place over the last 30 days?",
  "What was the average value of the point called Humidity Setpoint Foo last week?",
  "What was the average room temperature in March 2023?",
  "Which air handling unit serves the room temperature sensor?",
  "How many hours of data gaps were recorded in the last 30 days, by point?",
  "What was the temperature?",
];

/**
 * The logger writes JSON lines to stdout and the Markdown goes there too.
 * Route anything that looks like a structured log line to stderr, so the
 * Markdown stays pasteable and the log lines stay visible in the terminal.
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
  if (!env.present) {
    throw new Error(`Analyze is not configured. Missing: ${env.missing.join(", ")}`);
  }

  const pool = getAnalyzePool(env.values.askDatabaseUrl);
  const planner: Planner = createAnthropicPlanner(env.values.apiKey);
  const custom = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const questions = custom.length > 0 ? custom : SPEC_QUESTIONS;

  const schema = await getSchemaContext(pool, env.values.askDatabaseUrl);
  console.log(`# Analyze verification - ${new Date().toISOString()}`);
  console.log("");
  console.log(
    `Schema context: ${schema.objectCount} objects, ${schema.pointCount} points, ${schema.text.length} characters.`,
  );
  console.log("");

  // The audit row needs a real employee: `audit_events.actor_employee_id` is
  // a foreign key, and the first run of this script found that out. The
  // operator running the script IS the person asking, so the rows are
  // attributed to them - `--as=email`, else the first platform admin - and
  // the output says so, because "asked Building Automation" beside a name is
  // a claim that person should be able to recognise.
  const asEmail = process.argv.slice(2).find((a) => a.startsWith("--as="))?.slice(5) ?? null;
  const db = createDbClient();
  const employee = await db.employee.findFirst({
    where: asEmail === null ? { isPlatformAdmin: true } : { email: asEmail.toLowerCase() },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, firstName: true, lastName: true, isPlatformAdmin: true },
  });
  await db.$disconnect();
  if (employee === null) {
    throw new Error(
      asEmail === null
        ? "No platform admin exists in this database to attribute the audit rows to. Pass --as=<employee email>."
        : `No employee with email ${asEmail}.`,
    );
  }
  const viewer = {
    id: employee.id,
    email: employee.email,
    firstName: employee.firstName ?? "",
    lastName: employee.lastName ?? "",
    profileCompleted: true,
    isPlatformAdmin: employee.isPlatformAdmin,
  };
  console.log(`Audit rows are attributed to ${employee.email} (the operator running this script).`);
  console.log("");

  for (const question of questions) {
    console.log(`## ${question}`);
    console.log("");
    const started = Date.now();
    let result: AnalyzeResult;
    try {
      result = await analyzeQuestion(viewer, question, {
        planner,
        pool,
        rateLimiter: new QuestionRateLimiter({ limit: 1_000, windowMs: 1 }),
      });
    } catch (error) {
      console.log(`**Threw:** ${error instanceof Error ? error.message : String(error)}`);
      console.log("");
      continue;
    }
    print(result, Date.now() - started);

    // The invariant the gap question broke on 2026-09-21: a declared period
    // with no gap figure is the exact silence this feature exists to prevent.
    if (result.kind === "answered" || result.kind === "no_data") {
      const p = result.provenance;
      if (p.timeRange !== null && (p.gaps === null || p.scope === "none")) {
        faults += 1;
        console.log(
          "**FAULT:** a time range was declared but gap overlap was not computed " +
            `(scope ${p.scope}, gaps ${p.gaps === null ? "null" : "present"}). This run fails.`,
        );
        console.log("");
      }
      // The second shape of the same silence, found on the next run: the SQL
      // says `now() - interval '30 days'` and the plan says no period.
      if (p.periodUndeclared) {
        faults += 1;
        console.log(
          "**FAULT:** the SQL filters by time but the plan declared no period, even after " +
            "being asked again. The gap figure could not be computed. This run fails.",
        );
        console.log("");
      }
    }
  }

  await pool.end();

  if (faults > 0) {
    throw new Error(`${faults} result(s) declared a period without a gap figure.`);
  }
}

let faults = 0;

function print(result: AnalyzeResult, wallMs: number): void {
  console.log(`**Kind:** \`${result.kind}\` · ${(wallMs / 1000).toFixed(1)} s`);
  console.log("");

  switch (result.kind) {
    case "not_configured":
      console.log(`Missing: ${result.missing.join(", ")}`);
      break;
    case "clarify":
      console.log(`**Clarifying question:** ${result.question}`);
      console.log("");
      console.log(`Interpretation: ${result.interpretation}`);
      break;
    case "cannot_answer":
      console.log(`**Reason:** ${result.reason}`);
      console.log(`Retried: ${result.retried}`);
      for (const [i, attempt] of result.attempts.entries()) {
        console.log("");
        console.log(`Attempt ${i + 1}:`);
        if (attempt.sql) console.log("```sql\n" + attempt.sql + "\n```");
        console.log(`Error: ${attempt.error}`);
      }
      break;
    case "no_data":
    case "answered": {
      if (result.kind === "answered") {
        console.log(`**Answer (model):** ${result.answer}`);
      } else {
        console.log(`**No data (${result.reason}):** ${result.explanation}`);
      }
      console.log("");
      console.log(`Interpretation (model): ${result.interpretation}`);
      console.log(`Retried: ${result.retried}`);
      console.log("");
      console.log("```sql\n" + result.sql + "\n```");
      console.log("");
      const p = result.provenance;
      console.log("**Provenance (platform):**");
      console.log(`- Time range: ${p.timeRange ? `${p.timeRange.start} to ${p.timeRange.end}` : "none"}`);
      console.log(`- Scope: ${p.scope}; points: ${p.points.map((x) => `${x.name}${x.collected ? "" : " (not collected)"}`).join(", ") || "none"}`);
      console.log(
        `- Gaps: ${p.gaps === null ? "NOT COMPUTED" : `${p.gaps.totalHours} h in ${p.gaps.items.length} gap(s)`}` +
          (p.gaps && p.gaps.items.length > 0
            ? " - " + p.gaps.items.map((g) => `${g.pointName} ${g.start}..${g.end} (${g.hours} h, ${g.cause})`).join("; ")
            : ""),
      );
      console.log(`- Unknown roll horizon: ${p.unknownHorizon.count}${p.unknownHorizon.count > 0 ? ` (${p.unknownHorizon.names.join(", ")})` : ""}`);
      console.log(
        `- Coverage: ${p.coverage === null ? "n/a" : `${p.coverage.readings} readings, ${p.coverage.earliest ?? "-"} to ${p.coverage.latest ?? "-"}; never collected: ${p.coverage.neverCollected.join(", ") || "none"}`}`,
      );
      console.log(
        `- Coverage shortfall: ${
          p.coverageShortfall ??
          (p.coverage === null || p.timeRange === null
            ? "n/a - no readings or no period to compare"
            : "none - the readings held span the period asked about")
        }`,
      );
      console.log(`- Period undeclared: ${p.periodUndeclared}`);
      console.log(`- Unclassified points excluded: ${p.unclassifiedExcluded}`);
      console.log("");
      console.log(`**Rows:** ${result.table.rowCount}${result.table.truncated ? ` (capped at ${result.table.rowCap})` : ""}`);
      if (result.table.rowCount > 0) {
        console.log("");
        console.log(`| ${result.table.columns.join(" | ")} |`);
        console.log(`| ${result.table.columns.map(() => "---").join(" | ")} |`);
        for (const row of result.table.rows.slice(0, 25)) {
          console.log(`| ${row.map((c) => (c === null ? "NULL" : String(c))).join(" | ")} |`);
        }
        if (result.table.rowCount > 25) console.log(`| ... ${result.table.rowCount - 25} more |`);
      }
      break;
    }
  }
  console.log("");
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

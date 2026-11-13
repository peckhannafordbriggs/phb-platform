import "./load-env";
import { readAnthropicApiKey } from "../lib/env";
import { prisma } from "../lib/db";
import { createAnthropicNarrator, createFixedNarrator } from "../lib/modules/bas/reports/engine/narrative";
import { executeReportRun, ReportRunError } from "../lib/modules/bas/reports/engine/run";
import { STATUS_LABELS } from "../lib/modules/bas/reports/engine/rollup";
import { incidentPoints } from "../lib/modules/bas/reports/engine/analysis/data-health";
import { describeRunDuration, positiveAnswer } from "../lib/modules/bas/reports/engine/wording";

/**
 * Run one report definition end to end against DATABASE_URL and store the
 * run (Reports, Phase 2) - the way a report is produced before the
 * scheduler and worker exist (Phase 3).
 *
 *   npm run bas:report:run -- --definition <id> --period-end <iso> [--as <email>] [--no-narrative] [--fixed-narrative]
 *
 * --period-end     the instant the analysis window ends; the window is the
 *                  definition's. Defaults to now, which on a database whose
 *                  collection stopped is a period with no readings.
 * --as             the employee recorded as having started the run. Absent,
 *                  the platform started it.
 * --no-narrative   skip the model: the run finishes partial and says why.
 * --fixed-narrative  a canned narrator at a fixed cost per call, for a dry run.
 * Otherwise the model is called with ANTHROPIC_API_KEY, the BAS key, and the
 * run's cost is metered against the module's safety ceiling (the Usage page).
 *
 * Prints the run id, the status, the building status, every section's
 * status with its findings, the inventory's Not Applicable and Not Monitored
 * lists, and the cost. Exit code 1 on a failed run.
 */

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

async function main(): Promise<void> {
  const definition = arg("--definition");
  if (definition === null || !/^[0-9]+$/.test(definition)) {
    console.error("Usage: npm run bas:report:run -- --definition <id> --period-end <iso> [--as <email>] [--no-narrative] [--fixed-narrative]");
    process.exit(2);
  }
  const periodEndText = arg("--period-end");
  const periodEnd = periodEndText === null ? new Date() : new Date(periodEndText);
  if (Number.isNaN(periodEnd.getTime())) {
    console.error(`--period-end is not a date: ${periodEndText}`);
    process.exit(2);
  }

  let startedById: string | null = null;
  const as = arg("--as");
  if (as !== null) {
    const employee = await prisma.employee.findUnique({ where: { email: as.toLowerCase() }, select: { id: true } });
    if (employee === null) {
      console.error(`No employee with the address ${as}.`);
      process.exit(2);
    }
    startedById = employee.id;
  }

  let narrator = null;
  if (process.argv.includes("--fixed-narrative")) {
    narrator = createFixedNarrator();
  } else if (!process.argv.includes("--no-narrative")) {
    const key = readAnthropicApiKey();
    if (key === null) {
      console.error("ANTHROPIC_API_KEY is not set; the run will finish partial with no narrative. Pass --no-narrative to say so on purpose.");
    } else {
      narrator = createAnthropicNarrator(key);
    }
  }

  console.log(`Running definition ${definition} for the period ending ${periodEnd.toISOString()}${narrator === null ? " (no narrative)" : ` (narrator: ${narrator.model})`}`);
  const outcome = await executeReportRun(definition, { periodEnd, trigger: "manual", startedById, narrator });
  const doc = outcome.document;

  console.log("");
  console.log(`Run ${outcome.runId}: ${outcome.status}${outcome.partialReason !== null ? ` - ${outcome.partialReason}` : ""}`);
  console.log("PDF: queued for the worker (this script carries no Chromium; the worker job or `npm run bas:reports:worker` prints it)");
  console.log(`${doc.header.buildingName} · ${doc.header.periodStart} to ${doc.header.periodEnd} · ${doc.header.windowLabel}`);
  console.log(`Building status: ${STATUS_LABELS[doc.summary.status]} · new ${doc.summary.counts.new}, still open ${doc.summary.counts.stillOpen}, cleared ${doc.summary.counts.cleared}`);
  console.log(
    `Equipment types found: ${doc.inventory.equipmentTypesFound.map((t) => `${t.label} × ${t.count}`).join(", ") || "none"} · ${doc.inventory.pointsInScope} points, ${doc.inventory.equipmentInScope} equipment`,
  );
  if (doc.inventory.classification.length > 0) {
    console.log(`Classification: ${doc.inventory.classification.map((c) => `${c.name}: ${c.text}`).join("; ")}`);
  }
  console.log(`Required point checks met: ${doc.inventory.requiredPointsFound} of ${doc.inventory.requiredPointsTotal} (one check per question per unit it applies to)`);
  console.log(`Occupancy: ${doc.inventory.occupancy.map((o) => `${o.stationName}: ${o.kind} (${o.detail})`).join("; ")}`);
  console.log("");
  for (const s of doc.sections) {
    console.log(`  ${s.label}: ${s.status}${s.statusSentence ? ` - ${s.statusSentence}` : ""}`);
    for (const q of s.questions) {
      const detail =
        q.outcome === "not_monitored"
          ? `missing ${q.missing.join("; ")}`
          : q.outcome === "not_applicable"
            ? q.reason
            : q.outcome === "not_run"
              ? "could run; analysis not built yet"
              : q.key === "q20_data_health"
                ? `${String(q.metrics.judged ?? 0)} points judged, ${String(q.metrics.flagged ?? 0)} flagged in ${String(q.metrics.findings ?? q.metrics.flagged ?? 0)} finding(s)`
                : `over ${q.equipment.length} unit(s)${q.skipped.length > 0 ? `, skipped ${q.skipped.map((k) => `${k.name} (${k.reason})`).join(", ")}` : ""}`;
      // The page's one line for a question that ran and found nothing, so the console and the report agree.
      const live = s.findings.filter((f) => f.questionKey === q.key && f.state !== "cleared");
      console.log(`    Q${q.position} ${q.outcome}: ${detail}${q.outcome === "answered" && live.length === 0 ? ` - ${positiveAnswer(q)}` : ""}`);
    }
    for (const f of s.findings) {
      console.log(`      [${f.priority}] ${f.subjectName} - ${f.issue}: ${f.evidence.actual}; expected ${f.evidence.expected}; ${f.evidence.when} (${f.state})`);
      for (const p of incidentPoints(f.evidence)) console.log(`          ${p.name} - ${p.issue}: ${p.actual}; ${p.when}`);
      if (f.likelyCause !== null) console.log(`        likely: ${f.likelyCause}`);
      if (f.recommendedAction !== null) console.log(`        next: ${f.recommendedAction}`);
    }
  }
  if (doc.cleared.length > 0) console.log(`  Cleared: ${doc.cleared.map((f) => `${f.subjectName} (${f.issue})`).join(", ")}`);
  console.log("");
  console.log(
    `Cost: ${doc.cost.calls} call(s), ${doc.cost.inputTokens} in / ${doc.cost.outputTokens} out, $${doc.cost.costUsd.toFixed(4)} (safety ceiling $${doc.cost.budgetUsd.toFixed(2)}); took ${describeRunDuration(doc.header.durationMs ?? 0)}`,
  );
}

main()
  .catch((error) => {
    if (error instanceof ReportRunError) {
      console.error(`Run failed (${error.code}): ${error.message}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

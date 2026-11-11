import { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { BAS_MODULE_KEY } from "../../constants";
import { LIBRARY_SECTIONS, sectionLabel, type LibrarySection } from "../library";
import { WINDOW_LABELS } from "../schedule";
import { ANALYSIS_AVAILABILITY, NOT_BUILT_NOTE, dataHealth, manualOverrides, runOutsideSchedule, zoneComfort } from "./analysis";
import { carriedForward, compareFindings, type PreviousFinding } from "./compare";
import { decideQuestion, equipmentTypesFound } from "./inventory";
import type { Narrator, NarrativeInput } from "./narrative";
import { renderReportHtml } from "./html";
import { ReportRunError, enqueueRun } from "./queue";
import { buildingStatus, sectionStatus, topFindings } from "./rollup";
import { loadDefinition, resolveScope, type DefinitionForRun } from "./scope";
import type {
  Finding,
  Interval,
  QuestionResult,
  RawFinding,
  ReportDocument,
  RunStatus,
  SectionDocument,
} from "./types";

/**
 * One run, end to end (Reports, Phase 2): resolve the scope, compute
 * coverage and occupancy, decide every question, run the analysis functions
 * that exist, compare with the previous run, roll up the status, ask the
 * model for the narrative within the budget, render, store.
 *
 * The order is the spec's: Data Health FIRST, because a point it flags is
 * excluded from every equipment question; then the inventory decides Not
 * Applicable and Not Monitored; then the functions; then comparison and
 * status, with no model involved; then the narrative, which can only word
 * what is already decided; then the page.
 *
 * Status is decided at the end: `succeeded` when everything ran and every
 * section with findings has its narrative; `partial` with a reason when the
 * narrative was cut short - by the budget, by a missing key, by a declined
 * call - or when a question that could have run has no analysis yet, or
 * when the run's time cap was reached (Phase 3); `failed` with the error
 * when the run threw. A failed run is stored too, so the Reports list can
 * show it.
 *
 * THE RUN ROW COMES FIRST (Phase 3). A run is a row in `queued` before it
 * is anything else: the scheduler and Run now insert one with `enqueueRun`,
 * the worker claims it (`running`, heartbeat) and calls `executeQueuedRun`.
 * The dev script's `executeReportRun` is the same three steps in one call,
 * so there is one execution path and the worker is on it.
 *
 * TWO CAPS. The cost budget stops narrative calls at `budget_usd`. The time
 * cap, `max_minutes`, is a deadline read from the clock before every
 * question and every narrative call; past it, what is left is skipped and
 * named in the reason. Neither cap aborts: the comparison, the roll-up and
 * the page are always produced from whatever was computed.
 */

export interface RunOptions {
  periodEnd: Date;
  trigger: "manual" | "scheduled";
  /** The employee who asked, or null for the platform. */
  startedById: string | null;
  /** Null means no model is configured; the run finishes partial and says so. */
  narrator: Narrator | null;
  now?: Date;
  /** The clock the time cap reads, in epoch milliseconds. Tests move it. */
  clock?: () => number;
}

export interface ExecuteOptions {
  narrator: Narrator | null;
  now?: Date;
  clock?: () => number;
  /** Which claim of the run this is: 1 normally, 2 after a reclaim. In the audit row. */
  attempt?: number;
}

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  partialReason: string | null;
  document: ReportDocument;
  findings: number;
}

/** A question the time cap stopped before it was analysed. */
export const TIME_CAP_NOTE = "Not analysed: the run reached its time cap before this question.";

// The queue side lives in queue.ts, which imports no React: the service and
// the scheduler queue runs through it without pulling in the renderer.
export { ReportRunError, enqueueRun };

/**
 * Queue, claim and execute in one call - the dev script's path, and the
 * tests'. The worker does the same three things through `claimNextRun` and
 * `executeQueuedRun`.
 */
export async function executeReportRun(reportIdText: string | bigint, options: RunOptions): Promise<RunOutcome> {
  const reportId = typeof reportIdText === "bigint" ? reportIdText : BigInt(reportIdText);
  const now = options.now ?? new Date();
  const { runId } = await enqueueRun(prisma, {
    reportId,
    trigger: options.trigger,
    periodEnd: options.periodEnd,
    startedById: options.startedById,
  });
  await prisma.basReportRun.update({
    where: { runId },
    data: { status: "running", startedAt: now, heartbeatAt: now, attempts: { increment: 1 } },
  });
  return executeQueuedRun(runId, { narrator: options.narrator, now, clock: options.clock, attempt: 1 });
}

/**
 * Execute a run that has been claimed (`running`). Reads the period and the
 * trigger from the row, loads the definition as it is now, marks the previous
 * finished run for the comparison, and stores the result - or the failure.
 */
export async function executeQueuedRun(runIdInput: bigint | string, options: ExecuteOptions): Promise<RunOutcome> {
  const runId = typeof runIdInput === "bigint" ? runIdInput : BigInt(runIdInput);
  const row = await prisma.basReportRun.findUnique({
    where: { runId },
    select: { reportId: true, status: true, trigger: true, periodStart: true, periodEnd: true, startedById: true, attempts: true },
  });
  if (row === null) throw new ReportRunError("run_not_found", `No run ${runId}.`);
  if (row.status !== "running") throw new ReportRunError("run_not_claimed", `Run ${runId} is ${row.status}; it has to be claimed before it is executed.`);

  const def = await loadDefinition(row.reportId);
  if (def === null) throw new ReportRunError("report_not_found", `No report definition ${row.reportId}.`);

  const now = options.now ?? new Date();
  const clock = options.clock ?? Date.now;
  const range: Interval = { start: row.periodStart.getTime(), end: row.periodEnd.getTime() };
  const trigger: "manual" | "scheduled" = row.trigger === "scheduled" ? "scheduled" : "manual";

  const previous = await prisma.basReportRun.findFirst({
    where: { reportId: row.reportId, status: { in: ["succeeded", "partial"] }, runId: { not: runId } },
    orderBy: [{ finishedAt: "desc" }, { runId: "desc" }],
    select: { runId: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.basReportRun.update({ where: { runId }, data: { previousRunId: previous?.runId ?? null } });
    await writeAuditEvent(tx, {
      action: "bas.report_run_started",
      actorEmployeeId: row.startedById,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        reportId: row.reportId.toString(),
        runId: runId.toString(),
        name: def.name,
        trigger,
        attempt: options.attempt ?? row.attempts,
        periodStart: row.periodStart.toISOString(),
        periodEnd: row.periodEnd.toISOString(),
      },
    });
  });

  try {
    const result = await produce(def, range, runId, previous?.runId ?? null, options.narrator, now, clock);
    await prisma.$transaction(async (tx) => {
      await tx.basReportRun.update({
        where: { runId },
        data: {
          status: result.status,
          partialReason: result.partialReason,
          reportJson: result.document as unknown as Prisma.InputJsonValue,
          reportHtml: result.html,
          costUsd: new Prisma.Decimal(result.document.cost.costUsd.toFixed(6)),
          inputTokens: result.document.cost.inputTokens,
          outputTokens: result.document.cost.outputTokens,
          finishedAt: new Date(),
          heartbeatAt: new Date(),
        },
      });
      if (result.rows.length > 0) {
        await tx.basReportFinding.createMany({
          data: result.rows.map((f, position) => ({
            runId,
            position,
            questionKey: f.questionKey,
            section: f.section,
            subjectKey: f.subjectKey,
            subjectName: f.subjectName,
            equipmentId: f.equipmentId === null ? null : BigInt(f.equipmentId),
            issueCode: f.issueCode,
            priority: f.priority,
            evidence: f.evidence as unknown as Prisma.InputJsonValue,
            likelyCause: f.likelyCause,
            recommendedAction: f.recommendedAction,
            fingerprint: f.fingerprint,
            state: f.state,
            firstSeenRunId: f.firstSeenRunId === null ? null : BigInt(f.firstSeenRunId),
          })),
        });
      }
      await writeAuditEvent(tx, {
        action: "bas.report_run_finished",
        actorEmployeeId: row.startedById,
        moduleKey: BAS_MODULE_KEY,
        metadata: {
          reportId: row.reportId.toString(),
          runId: runId.toString(),
          name: def.name,
          status: result.status,
          partialReason: result.partialReason,
          buildingStatus: result.document.summary.status,
          findings: result.rows.filter((f) => f.state !== "cleared").length,
          cleared: result.rows.filter((f) => f.state === "cleared").length,
          costUsd: result.document.cost.costUsd,
          inputTokens: result.document.cost.inputTokens,
          outputTokens: result.document.cost.outputTokens,
        },
      });
    });
    logger.info("bas.report_run", {
      outcome: result.status,
      reason: `run ${runId} of report ${row.reportId}: $${result.document.cost.costUsd.toFixed(4)}, ${result.rows.length} findings`,
    });
    return {
      runId: runId.toString(),
      status: result.status,
      partialReason: result.partialReason,
      document: result.document,
      findings: result.rows.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.$transaction(async (tx) => {
      await tx.basReportRun.update({
        where: { runId },
        data: { status: "failed", error: message, finishedAt: new Date() },
      });
      await writeAuditEvent(tx, {
        action: "bas.report_run_finished",
        actorEmployeeId: row.startedById,
        moduleKey: BAS_MODULE_KEY,
        metadata: { reportId: row.reportId.toString(), runId: runId.toString(), name: def.name, status: "failed", error: message },
      });
    });
    logger.error("bas.report_run_failed", { outcome: "failed", reason: `run ${runId} of report ${row.reportId}: ${message}` });
    throw new ReportRunError("run_failed", message);
  }
}

interface Produced {
  status: RunStatus;
  partialReason: string | null;
  document: ReportDocument;
  html: string;
  rows: Finding[];
}

async function produce(
  def: DefinitionForRun,
  range: Interval,
  runId: bigint,
  previousRunId: bigint | null,
  narrator: Narrator | null,
  now: Date,
  clock: () => number,
): Promise<Produced> {
  // The time cap: a deadline on the clock, read before every question and
  // every narrative call. Past it, nothing new is started.
  const startedMs = clock();
  const deadlineMs = startedMs + def.maxMinutes * 60_000;
  const pastDeadline = () => clock() > deadlineMs;
  const skippedQuestions: number[] = [];
  const skippedNarrative: string[] = [];

  const scope = await resolveScope(def, range);
  const tz = def.site.timezone;

  // Data Health first; its flagged points are excluded from everything else.
  const health = dataHealth(scope.points, range, tz);
  const excluded = health.excluded;

  const libraryQuestions = def.questions.filter((q) => q.library !== null).map((q) => q.library!);
  const plannerQuestions = def.questions.filter((q) => q.library === null).map((q) => ({ text: q.text, note: "Custom questions are answered by the Analyze planner from Phase 6; not run in this report." }));

  const stationOf = (unit: { equipmentId: string }) => scope.stationOfUnit.get(unit.equipmentId) ?? null;
  const results: QuestionResult[] = [];
  const rawFindings: RawFinding[] = [];
  const partialReasons: string[] = [];
  let requiredFound = 0;
  let requiredTotal = 0;
  const lowCoverage = new Map<string, number>();
  const comfortCache = new Map<string, ReturnType<typeof zoneComfort>>();

  for (const q of libraryQuestions.sort((a, b) => a.position - b.position)) {
    const availability = ANALYSIS_AVAILABILITY[q.key] ?? "not_built";
    const base: QuestionResult = {
      key: q.key,
      position: q.position,
      section: q.section as LibrarySection,
      text: q.text,
      kind: q.kind === "planner" ? "planner" : "computed",
      outcome: "answered",
      missing: [],
      reason: null,
      equipment: [],
      skipped: [],
      metrics: {},
    };

    // Data Health is already computed above, so the cap never skips it.
    if (q.key === "q20_data_health") {
      rawFindings.push(...health.findings);
      results.push({ ...base, metrics: { judged: health.judged, flagged: health.findings.length } });
      continue;
    }
    if (availability === "derived") {
      results.push({ ...base, metrics: {} });
      continue;
    }
    if (pastDeadline()) {
      results.push({ ...base, outcome: "not_run", reason: TIME_CAP_NOTE });
      skippedQuestions.push(q.position);
      continue;
    }

    const decision = decideQuestion(q, scope.units, scope.pointsByStation, scope.occupancyByStation, stationOf, excluded);
    for (const lc of decision.lowCoverage) lowCoverage.set(lc.name, lc.coverage);
    // The inventory's "required points found" counts units that had what the question needs.
    requiredTotal += decision.qualified.length + decision.skipped.length;
    requiredFound += decision.qualified.length;

    if (decision.outcome === "not_applicable") {
      results.push({ ...base, outcome: "not_applicable", reason: decision.reason });
      continue;
    }
    if (decision.outcome === "not_monitored") {
      results.push({ ...base, outcome: "not_monitored", missing: decision.missing, skipped: decision.skipped });
      continue;
    }
    if (availability === "not_built") {
      results.push({
        ...base,
        outcome: "not_run",
        reason: NOT_BUILT_NOTE,
        equipment: decision.qualified.map((u) => u.name),
        skipped: decision.skipped,
        missing: decision.missing,
      });
      partialReasons.push(`Q${q.position} could run but has no analysis yet`);
      continue;
    }

    // Occupancy for the qualified units: one source per station; the
    // comfort and schedule questions take the union across the stations in
    // scope, each unit judged against its own station's hours.
    const occupiedFor = (unitId: string): Interval[] => {
      const station = scope.stationOfUnit.get(unitId);
      return (station === undefined ? null : scope.occupancyByStation.get(station)?.intervals) ?? [];
    };

    switch (q.key) {
      case "q03_zone_comfort":
      case "q04_worst_zones": {
        const cacheKey = decision.qualified.map((u) => u.equipmentId).join(",");
        let comfort = comfortCache.get(cacheKey);
        if (comfort === undefined) {
          // Units may sit on different stations with different occupancy; judge per station.
          const byStation = new Map<string, typeof decision.qualified>();
          for (const u of decision.qualified) {
            const s = scope.stationOfUnit.get(u.equipmentId) ?? "";
            byStation.set(s, [...(byStation.get(s) ?? []), u]);
          }
          const parts = [...byStation.entries()].map(([, units]) =>
            zoneComfort(units, occupiedFor(units[0]!.equipmentId), range, tz, excluded),
          );
          comfort = {
            zones: parts.flatMap((p) => p.zones),
            findings: parts.flatMap((p) => p.findings),
            overallPercentInBand: weightedPercent(parts.flatMap((p) => p.zones)),
            worst: parts
              .flatMap((p) => p.zones)
              .filter((z) => z.percentInBand !== null)
              .sort((a, b) => a.percentInBand! - b.percentInBand!)
              .slice(0, 10),
            skipped: parts.flatMap((p) => p.skipped),
          };
          comfortCache.set(cacheKey, comfort);
        }
        if (q.key === "q03_zone_comfort") {
          rawFindings.push(...comfort.findings);
          results.push({
            ...base,
            equipment: decision.qualified.map((u) => u.name),
            skipped: [...decision.skipped, ...comfort.skipped],
            metrics: { overallPercentInBand: comfort.overallPercentInBand, zones: comfort.zones },
          });
        } else {
          results.push({
            ...base,
            equipment: decision.qualified.map((u) => u.name),
            skipped: decision.skipped,
            metrics: { worstZones: comfort.worst },
          });
        }
        break;
      }
      case "q05_manual_overrides": {
        const r = manualOverrides(scope.points, range, tz, excluded);
        rawFindings.push(...r.findings);
        results.push({ ...base, equipment: decision.qualified.map((u) => u.name), skipped: decision.skipped, metrics: { judged: r.judged } });
        break;
      }
      case "q19_run_outside_schedule": {
        const byStation = new Map<string, typeof decision.qualified>();
        for (const u of decision.qualified) {
          const s = scope.stationOfUnit.get(u.equipmentId) ?? "";
          byStation.set(s, [...(byStation.get(s) ?? []), u]);
        }
        const parts = [...byStation.entries()].map(([, units]) =>
          runOutsideSchedule(units, occupiedFor(units[0]!.equipmentId), range, tz, excluded),
        );
        rawFindings.push(...parts.flatMap((p) => p.findings));
        results.push({
          ...base,
          equipment: decision.qualified.map((u) => u.name),
          skipped: decision.skipped,
          metrics: { schedules: parts.flatMap((p) => p.results) },
        });
        break;
      }
      default:
        results.push({ ...base, outcome: "not_run", reason: NOT_BUILT_NOTE, equipment: decision.qualified.map((u) => u.name) });
        partialReasons.push(`Q${q.position} could run but has no analysis yet`);
    }
  }

  // Comparison with the previous run.
  const previousFindings: PreviousFinding[] =
    previousRunId === null
      ? []
      : (
          await prisma.basReportFinding.findMany({
            where: { runId: previousRunId },
            include: { firstSeenRun: { select: { startedAt: true, createdAt: true } } },
          })
        ).map((f) => ({
          fingerprint: f.fingerprint,
          state: f.state,
          priority: f.priority === "action_needed" ? "action_needed" : "watch",
          firstSeenRunId: f.firstSeenRunId?.toString() ?? null,
          firstSeenAt: (f.firstSeenRun?.startedAt ?? f.firstSeenRun?.createdAt)?.toISOString() ?? null,
          finding: {
            questionKey: f.questionKey,
            section: f.section as LibrarySection,
            subjectKey: f.subjectKey,
            equipmentId: f.equipmentId?.toString() ?? null,
            subjectName: f.subjectName,
            issueCode: f.issueCode,
            issue: (f.evidence as { issue?: string }).issue ?? f.issueCode,
            priority: f.priority === "action_needed" ? "action_needed" : "watch",
            evidence: f.evidence as Finding["evidence"],
            firstSeenRunId: f.firstSeenRunId?.toString() ?? null,
            firstSeenAt: (f.firstSeenRun?.startedAt ?? f.firstSeenRun?.createdAt)?.toISOString() ?? null,
            likelyCause: f.likelyCause,
            recommendedAction: f.recommendedAction,
            fixLocation: null,
          },
        }));
  // The issue label travels in the evidence so a cleared row can show it.
  for (const f of rawFindings) f.evidence.issue = f.issue;
  const comparison = compareFindings(rawFindings, previousFindings, runId.toString(), now.toISOString());

  // Sections, in the template's order, from the questions this report carries.
  const sections: SectionDocument[] = [];
  for (const s of LIBRARY_SECTIONS) {
    if (s.key === "summary") continue;
    const questions = results.filter((r) => r.section === s.key);
    if (questions.length === 0) continue;
    const findings = comparison.findings.filter((f) => f.section === s.key);
    const answered = questions.some((q) => q.outcome === "answered");
    const status: SectionDocument["status"] = questions.every((q) => q.outcome === "not_applicable")
      ? "not_applicable"
      : answered
        ? sectionStatus(findings)
        : questions.every((q) => q.outcome === "not_run" || q.outcome === "not_applicable")
          ? "not_run"
          : "not_monitored";
    const notRunSentence = questions.filter((q) => q.outcome === "not_run").every((q) => q.reason === TIME_CAP_NOTE)
      ? TIME_CAP_NOTE
      : NOT_BUILT_NOTE;
    sections.push({
      key: s.key,
      label: s.label,
      status,
      statusSentence: status === "good" ? "Everything judged was within tolerance." : status === "not_monitored" ? "The points this section needs are not trended, or not trended enough; see the inventory." : status === "not_run" ? notRunSentence : "",
      questions,
      findings,
    });
  }

  // The narrative, within the budget and the time cap.
  const cost = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
  const toNarrate = sections.filter((s) => (s.status === "watch" || s.status === "action_needed") && s.findings.some((f) => f.state !== "cleared"));
  let narrated = 0;
  if (narrator === null) {
    if (toNarrate.length > 0) partialReasons.unshift("Narrative not generated: no model key is configured");
  } else {
    const periodLabel = `${new Date(range.start).toISOString().slice(0, 10)} to ${new Date(range.end).toISOString().slice(0, 10)}`;
    for (const section of toNarrate) {
      if (pastDeadline()) {
        skippedNarrative.push(section.label);
        continue;
      }
      const live = section.findings.filter((f) => f.state !== "cleared");
      const input: NarrativeInput = {
        buildingName: def.site.name,
        periodLabel,
        sectionLabel: section.label,
        status: section.status as "watch" | "action_needed",
        findings: live.map((f, index) => ({ index, subject: f.subjectName, issue: f.issue, priority: f.priority, state: f.state, evidence: f.evidence })),
      };
      const estimate = narrator.estimate(input);
      if (cost.costUsd + estimate > def.budgetUsd) {
        partialReasons.unshift(
          `Budget of $${def.budgetUsd.toFixed(2)} reached after ${narrated} of ${toNarrate.length} sections had narrative; the rest show their evidence only`,
        );
        break;
      }
      const result = await narrator.narrate(input);
      cost.calls += 1;
      cost.inputTokens += result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens;
      cost.outputTokens += result.usage.outputTokens;
      cost.costUsd += result.costUsd;
      if (result.declined !== null) {
        partialReasons.unshift(`${section.label}: ${result.declined}`);
        continue;
      }
      narrated += 1;
      section.statusSentence = result.statusSentence ?? section.statusSentence;
      for (const out of result.findings) {
        const f = live[out.index];
        if (f === undefined) continue;
        f.likelyCause = out.likelyCause;
        f.recommendedAction = out.recommendedAction;
        f.fixLocation = out.fixLocation === "unknown" ? null : out.fixLocation;
      }
    }
  }

  if (skippedQuestions.length > 0 || skippedNarrative.length > 0) {
    const elapsedMin = Math.max(1, Math.round((clock() - startedMs) / 60_000));
    const parts = [
      skippedQuestions.length > 0 ? `${skippedQuestions.map((p) => `Q${p}`).join(", ")} not analysed` : null,
      skippedNarrative.length > 0 ? `narrative skipped for ${skippedNarrative.join(", ")}` : null,
    ].filter((p): p is string => p !== null);
    partialReasons.unshift(`Time cap of ${def.maxMinutes} min reached after ${elapsedMin} min: ${parts.join("; ")}`);
  }

  const liveFindings = comparison.findings;
  const summaryStatus = buildingStatus(sections);
  const status: RunStatus = partialReasons.length > 0 ? "partial" : "succeeded";
  const partialReason = partialReasons.length > 0 ? partialReasons.join("; ") : null;

  const document: ReportDocument = {
    version: 1,
    header: {
      definitionName: def.name,
      presetLabel: def.presetLabel,
      buildingName: def.site.name,
      stationNames: scope.stations.map((s) => s.name),
      periodStart: new Date(range.start).toISOString(),
      periodEnd: new Date(range.end).toISOString(),
      timezone: tz,
      windowLabel: WINDOW_LABELS[def.analysisWindow],
      outdoor: scope.outdoor,
      generatedAt: now.toISOString(),
      status,
      partialReason,
    },
    inventory: {
      equipmentTypesFound: equipmentTypesFound(scope.units),
      requiredPointsFound: requiredFound,
      requiredPointsTotal: requiredTotal,
      lowCoverage: [...lowCoverage.entries()].map(([name, coverage]) => ({ name, coverage })).sort((a, b) => a.coverage - b.coverage),
      notMonitored: results.filter((r) => r.outcome === "not_monitored").map((r) => ({ position: r.position, key: r.key, text: r.text, missing: r.missing })),
      notApplicable: results.filter((r) => r.outcome === "not_applicable").map((r) => ({ position: r.position, key: r.key, text: r.text, reason: r.reason ?? "" })),
      occupancy: [...scope.occupancyByStation.values()].map((o) => ({ stationName: o.stationName, kind: o.kind, detail: o.detail })),
      pointsInScope: scope.points.length,
      equipmentInScope: scope.units.length,
    },
    summary: {
      status: summaryStatus,
      topFindings: topFindings(liveFindings),
      counts: comparison.counts,
      siteVisit: liveFindings.filter((f) => f.fixLocation === "site").map((f) => f.subjectName),
      remoteFix: liveFindings.filter((f) => f.fixLocation === "remote").map((f) => f.subjectName),
    },
    sections,
    cleared: comparison.cleared,
    carriedForward: carriedForward(liveFindings),
    plannerQuestions,
    cost: { ...cost, budgetUsd: def.budgetUsd, model: narrator?.model ?? null },
  };

  const rows: Finding[] = [...liveFindings, ...comparison.cleared];
  return { status, partialReason, document, html: renderReportHtml(document), rows };
}

function weightedPercent(zones: Array<{ judgedMinutes: number; inBandMinutes: number }>): number | null {
  const judged = zones.reduce((s, z) => s + z.judgedMinutes, 0);
  if (judged === 0) return null;
  return Math.round((zones.reduce((s, z) => s + z.inBandMinutes, 0) / judged) * 1000) / 10;
}

export { sectionLabel };

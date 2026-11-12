import { prisma } from "@/lib/db";
import {
  DAY_MS,
  USAGE_RANGES,
  addToTally,
  dayKey,
  monthLabel,
  rangeDays,
  tallyRows,
  type Tally,
  type UsageDay,
  type UsageMonth,
  type UsageRange,
  type UsageRow,
  type UsageTotals,
} from "@/lib/usage/range";
import type { RunStatus, RunStepSnapshot } from "./runs";

/**
 * Usage & cost: Claude spend recorded by runs. The source is the worker's
 * `step_cost` events (one per run step, kept current as the step goes), so a
 * step is counted on the day it last spent. Days are America/New_York.
 * The hard limit is the Anthropic Console spend limit; this page only reports.
 *
 * The range arithmetic and the row shapes are shared with the BAS Reports
 * Usage page (lib/usage/range.ts, 2026-11-12); re-exported here so this
 * module's importers keep their path.
 */

export { USAGE_RANGES, parseUsageRange, type UsageRange, type UsageRow } from "@/lib/usage/range";

export type UsageRun = {
  id: string;
  workflowName: string;
  projectName: string;
  status: RunStatus;
  createdAt: Date;
  tokens: number;
  spend: number;
};
export type Usage = {
  range: UsageRange;
  totals: UsageTotals;
  thisMonth: UsageMonth;
  days: UsageDay[];
  bySkill: UsageRow[];
  byProject: UsageRow[];
  byWorkflow: UsageRow[];
  topRuns: UsageRun[];
};

export async function getUsage(range: UsageRange, now = new Date()): Promise<Usage> {
  const count = USAGE_RANGES[range];
  const today = dayKey(now);
  const days = rangeDays(today, count);
  const first = days[0]!.date;
  const month = today.slice(0, 7);

  // Wide enough for the range and the whole current month; the day keys do the exact cut.
  const since = new Date(now.getTime() - (Math.max(count, 31) + 1) * DAY_MS);
  const events = await prisma.cipRunEvent.findMany({
    where: { type: "step_cost", at: { gte: since } },
    select: {
      runId: true,
      step: true,
      data: true,
      at: true,
      run: {
        select: { workflowName: true, steps: true, status: true, createdAt: true, project: { select: { folderName: true } } },
      },
    },
  });

  const perDay = new Map<string, number>();
  const bySkill: Tally = new Map();
  const byProject: Tally = new Map();
  const byWorkflow: Tally = new Map();
  const perRun = new Map<string, UsageRun>();
  let thisMonth = 0;

  for (const e of events) {
    const data = e.data as { cost?: number; input?: number; output?: number };
    const spend = data.cost ?? 0;
    const tokens = (data.input ?? 0) + (data.output ?? 0);
    const key = dayKey(e.at);
    if (key.startsWith(month)) thisMonth += spend;
    if (key < first) continue;

    const runId = e.runId.toString();
    const skill = (e.run.steps as RunStepSnapshot[])[e.step ?? -1]?.folderName ?? `Step ${(e.step ?? 0) + 1}`;
    perDay.set(key, (perDay.get(key) ?? 0) + spend);
    addToTally(bySkill, skill, runId, tokens, spend);
    addToTally(byProject, e.run.project.folderName, runId, tokens, spend);
    addToTally(byWorkflow, e.run.workflowName, runId, tokens, spend);

    const run = perRun.get(runId) ?? {
      id: runId,
      workflowName: e.run.workflowName,
      projectName: e.run.project.folderName,
      status: e.run.status as RunStatus,
      createdAt: e.run.createdAt,
      tokens: 0,
      spend: 0,
    };
    run.tokens += tokens;
    run.spend += spend;
    perRun.set(runId, run);
  }

  const runs = [...perRun.values()];
  return {
    range,
    totals: {
      runs: runs.length,
      tokens: runs.reduce((a, r) => a + r.tokens, 0),
      spend: runs.reduce((a, r) => a + r.spend, 0),
    },
    thisMonth: { label: monthLabel(month), spend: thisMonth },
    days: days.map((d) => ({ ...d, spend: perDay.get(d.date) ?? 0 })),
    bySkill: tallyRows(bySkill),
    byProject: tallyRows(byProject),
    byWorkflow: tallyRows(byWorkflow),
    topRuns: runs.sort((a, b) => b.spend - a.spend).slice(0, 10),
  };
}

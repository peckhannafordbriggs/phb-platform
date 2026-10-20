import { prisma } from "@/lib/db";
import type { RunStatus, RunStepSnapshot } from "./runs";

/**
 * Usage & cost: Claude spend recorded by runs. The source is the worker's
 * `step_cost` events (one per run step, kept current as the step goes), so a
 * step is counted on the day it last spent. Days are America/New_York.
 * The hard limit is the Anthropic Console spend limit; this page only reports.
 */

export const USAGE_RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;
export type UsageRange = keyof typeof USAGE_RANGES;

/** Anything not a known range falls back to 30 days. */
export const parseUsageRange = (raw: unknown): UsageRange =>
  typeof raw === "string" && Object.hasOwn(USAGE_RANGES, raw) ? (raw as UsageRange) : "30d";

/** Spend in US dollars. `runs` counts runs that spent in the range. */
export type UsageRow = { label: string; runs: number; tokens: number; spend: number };
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
  totals: { runs: number; tokens: number; spend: number };
  thisMonth: { label: string; spend: number };
  days: { date: string; label: string; spend: number }[];
  bySkill: UsageRow[];
  byProject: UsageRow[];
  byWorkflow: UsageRow[];
  topRuns: UsageRun[];
};

const ZONE = "America/New_York";
const DAY_MS = 86_400_000;
const KEY = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const SHORT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long" });

/** YYYY-MM-DD in New York. */
const dayKey = (at: Date) => KEY.format(at);

/** The calendar days of the range, oldest first, ending today. */
function rangeDays(today: string, count: number): { date: string; label: string }[] {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(Date.UTC(y, m - 1, d - (count - 1 - i)));
    return { date: day.toISOString().slice(0, 10), label: SHORT.format(day) };
  });
}

type Tally = Map<string, { label: string; runs: Set<string>; tokens: number; spend: number }>;

function add(tally: Tally, key: string, runId: string, tokens: number, spend: number) {
  const row = tally.get(key) ?? { label: key, runs: new Set<string>(), tokens: 0, spend: 0 };
  row.runs.add(runId);
  row.tokens += tokens;
  row.spend += spend;
  tally.set(key, row);
}

const rows = (tally: Tally): UsageRow[] =>
  [...tally.values()]
    .map((r) => ({ label: r.label, runs: r.runs.size, tokens: r.tokens, spend: r.spend }))
    .sort((a, b) => b.spend - a.spend || a.label.localeCompare(b.label));

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
    add(bySkill, skill, runId, tokens, spend);
    add(byProject, e.run.project.folderName, runId, tokens, spend);
    add(byWorkflow, e.run.workflowName, runId, tokens, spend);

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
  const [y, m] = month.split("-").map(Number) as [number, number];
  return {
    range,
    totals: {
      runs: runs.length,
      tokens: runs.reduce((a, r) => a + r.tokens, 0),
      spend: runs.reduce((a, r) => a + r.spend, 0),
    },
    thisMonth: { label: MONTH.format(new Date(Date.UTC(y, m - 1, 1))), spend: thisMonth },
    days: days.map((d) => ({ ...d, spend: perDay.get(d.date) ?? 0 })),
    bySkill: rows(bySkill),
    byProject: rows(byProject),
    byWorkflow: rows(byWorkflow),
    topRuns: runs.sort((a, b) => b.spend - a.spend).slice(0, 10),
  };
}

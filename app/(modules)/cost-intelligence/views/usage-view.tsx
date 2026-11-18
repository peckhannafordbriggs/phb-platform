"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { Usage } from "@/lib/modules/cost-intelligence/usage";
import { USAGE_RANGE_OPTIONS } from "@/lib/usage/range";
import { SpendPerDayChart, UsageBreakdownTable, UsageStat, formatMoney, formatTokens } from "@/components/ui/Usage";
import { Card } from "../ui/Card";
import { Label } from "../ui/Label";
import { Segmented } from "../ui/Segmented";
import { Table } from "../ui/Table";
import { StatusPill } from "./runs-view";

type Breakdown = "bySkill" | "byProject" | "byWorkflow";
const BREAKDOWNS: { value: Breakdown; label: string }[] = [
  { value: "bySkill", label: "By skill" },
  { value: "byProject", label: "By project" },
  { value: "byWorkflow", label: "By workflow" },
];

const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

/**
 * Claude spend for Cost Intelligence runs, from what the worker recorded.
 * The tiles, the bars and the breakdown table are the shared kit's
 * (components/ui/Usage.tsx, 2026-11-12); this view supplies the data and
 * the two things that are this module's - the breakdown keys and the runs
 * table with its status pill.
 */
export function UsageView({ usage }: { usage: Usage }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [breakdown, setBreakdown] = useState<Breakdown>("bySkill");
  const { totals, days } = usage;

  return (
    <div className={"flex flex-col gap-5 " + (pending ? "opacity-60" : "")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Date range"
          options={USAGE_RANGE_OPTIONS}
          value={usage.range}
          onChange={(range) => startTransition(() => router.push(`?range=${range}`))}
        />
        <span className="text-[0.8125rem] text-[var(--muted)]">
          Claude spend recorded by runs. The hard limit is the Anthropic Console spend limit.
        </span>
      </div>

      <div className="grid grid-cols-2 gap-5 lg:grid-cols-5">
        <UsageStat label="Spend" value={formatMoney(totals.spend)} />
        <UsageStat label="Runs" value={totals.runs.toLocaleString("en-US")} />
        <UsageStat label="Average per run" value={formatMoney(totals.spend / Math.max(totals.runs, 1))} />
        <UsageStat label="Tokens" value={formatTokens(totals.tokens)} />
        <UsageStat label={`${usage.thisMonth.label} so far`} value={formatMoney(usage.thisMonth.spend)} />
      </div>

      <SpendPerDayChart days={days} />

      <Card padding="p-0">
        <div className="border-b border-[var(--divider-soft)] px-5 py-3">
          <Segmented label="Breakdown" tone="light" options={BREAKDOWNS} value={breakdown} onChange={setBreakdown} />
        </div>
        <UsageBreakdownTable rows={usage[breakdown]} />
      </Card>

      <Card>
        <Label>Most expensive runs</Label>
        {usage.topRuns.length === 0 ? (
          <p className="py-6 text-center text-[0.8125rem] text-[var(--muted)]">No runs in this range.</p>
        ) : (
          <Table
            headers={["Run", "Workflow", "Project", "Status", "Started", "Spend"]}
            rows={usage.topRuns.map((r) => [
              <span key="id" className="font-mono text-[0.75rem]">{`#${r.id}`}</span>,
              <span key="w" className="truncate">{r.workflowName}</span>,
              <span key="p" className="truncate">{r.projectName}</span>,
              <StatusPill key="s" status={r.status} />,
              WHEN.format(r.createdAt),
              <span key="c" className="font-semibold tabular-nums">{formatMoney(r.spend)}</span>,
            ])}
            onRowClick={(i) => router.push(`/cost-intelligence/runs/${usage.topRuns[i]!.id}`)}
          />
        )}
      </Card>
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { Usage, UsageRange, UsageRow } from "@/lib/modules/cost-intelligence/usage";
import { Card } from "../ui/Card";
import { Label } from "../ui/Label";
import { Segmented } from "../ui/Segmented";
import { Table } from "../ui/Table";
import { StatusPill } from "./runs-view";

const RANGES: { value: UsageRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

type Breakdown = "bySkill" | "byProject" | "byWorkflow";
const BREAKDOWNS: { value: Breakdown; label: string }[] = [
  { value: "bySkill", label: "By skill" },
  { value: "byProject", label: "By project" },
  { value: "byWorkflow", label: "By workflow" },
];

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);
const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

/** Claude spend for Cost Intelligence runs, from what the worker recorded. */
export function UsageView({ usage }: { usage: Usage }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [breakdown, setBreakdown] = useState<Breakdown>("bySkill");
  const { totals, days } = usage;
  const peak = Math.max(...days.map((d) => d.spend), 0);

  return (
    <div className={"flex flex-col gap-5 " + (pending ? "opacity-60" : "")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Date range"
          options={RANGES}
          value={usage.range}
          onChange={(range) => startTransition(() => router.push(`?range=${range}`))}
        />
        <span className="text-[0.8125rem] text-[var(--muted)]">
          Claude spend recorded by runs. The hard limit is the Anthropic Console spend limit.
        </span>
      </div>

      <div className="grid grid-cols-2 gap-5 lg:grid-cols-5">
        <Stat label="Spend" value={money(totals.spend)} />
        <Stat label="Runs" value={totals.runs.toLocaleString("en-US")} />
        <Stat label="Average per run" value={money(totals.spend / Math.max(totals.runs, 1))} />
        <Stat label="Tokens" value={tokens(totals.tokens)} />
        <Stat label={`${usage.thisMonth.label} so far`} value={money(usage.thisMonth.spend)} />
      </div>

      <Card>
        <div className="flex items-baseline justify-between">
          <Label>Spend per day</Label>
          <span className="text-[0.75rem] text-[var(--muted)]">Hover a bar for the amount</span>
        </div>
        {peak === 0 ? (
          <p className="py-14 text-center text-[0.8125rem] text-[var(--muted)]">No spend in this range.</p>
        ) : (
          <div className="flex h-44 items-end gap-[3px]">
            {days.map((d) => (
              <div
                key={d.date}
                title={`${d.label}: ${money(d.spend)}`}
                className="flex-1 rounded-t-sm opacity-80 hover:opacity-100"
                style={{
                  height: `${(d.spend / peak) * 100}%`,
                  minHeight: 2,
                  background: d.spend > 0 ? "var(--module-accent)" : "var(--neutral-100)",
                }}
              />
            ))}
          </div>
        )}
        <div className="mt-2 flex justify-between text-[0.75rem] text-[var(--muted)]">
          <span>{days[0]?.label}</span>
          <span>Today</span>
        </div>
      </Card>

      <Card padding="p-0">
        <div className="border-b border-[var(--divider-soft)] px-5 py-3">
          <Segmented label="Breakdown" tone="light" options={BREAKDOWNS} value={breakdown} onChange={setBreakdown} />
        </div>
        <BreakdownTable rows={usage[breakdown]} />
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
              <span key="c" className="font-semibold tabular-nums">{money(r.spend)}</span>,
            ])}
            onRowClick={(i) => router.push(`/cost-intelligence/runs/${usage.topRuns[i]!.id}`)}
          />
        )}
      </Card>
    </div>
  );
}

const COLUMNS = "grid-cols-[minmax(0,1fr)_4rem_5rem_6rem_5rem]";

function BreakdownTable({ rows }: { rows: UsageRow[] }) {
  if (rows.length === 0) {
    return <p className="px-5 py-6 text-center text-[0.8125rem] text-[var(--muted)]">No runs in this range.</p>;
  }
  const top = Math.max(...rows.map((r) => r.spend), 0.01);
  return (
    <>
      <div className={`grid ${COLUMNS} gap-4 border-b border-[var(--divider-soft)] px-5 py-3`}>
        {["Name", "Runs", "Tokens", "Spend", "Per run"].map((h, i) => (
          <span key={h} className={"eyebrow text-[var(--muted)] " + (i > 0 ? "text-right" : "")}>
            {h}
          </span>
        ))}
      </div>
      {rows.map((r) => (
        <div
          key={r.label}
          className={`grid ${COLUMNS} items-center gap-4 border-b border-[var(--divider-soft)] px-5 py-3 text-[0.8125rem] last:border-b-0`}
        >
          <span className="flex min-w-0 items-center gap-4">
            <span className="truncate">{r.label}</span>
            <span className="hidden h-1.5 w-40 shrink-0 rounded-full bg-[var(--neutral-100)] sm:block">
              <span
                className="block h-full rounded-full"
                style={{ width: `${(r.spend / top) * 100}%`, background: "var(--module-accent)" }}
              />
            </span>
          </span>
          <span className="text-right tabular-nums">{r.runs}</span>
          <span className="text-right tabular-nums">{tokens(r.tokens)}</span>
          <span className="text-right font-semibold tabular-nums">{money(r.spend)}</span>
          <span className="text-right tabular-nums text-[var(--muted)]">{money(r.spend / Math.max(r.runs, 1))}</span>
        </div>
      ))}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <Label>{label}</Label>
      <p className="text-3xl font-semibold tabular-nums">{value}</p>
    </Card>
  );
}

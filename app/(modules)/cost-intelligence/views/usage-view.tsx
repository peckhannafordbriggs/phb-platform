"use client";

import { useState } from "react";
import { PLACEHOLDER_BUDGET, PLACEHOLDER_USAGE } from "@/lib/modules/cost-intelligence/placeholder-settings";
import type { UsageRange } from "@/lib/modules/cost-intelligence/types";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Label } from "../ui/Label";
import { Segmented } from "../ui/Segmented";

const RANGES: { value: UsageRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "quarter", label: "Quarter" },
];

const dollars = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const cents = (n: number) => `$${n.toFixed(2)}`;
const millions = (n: number) => `${(n / 1_000_000).toFixed(1)}M`;

/** Anthropic spend for Cost Intelligence runs. */
export function UsageView() {
  const [range, setRange] = useState<UsageRange>("30d");
  const { days, bySkill } = PLACEHOLDER_USAGE[range];
  const runs = bySkill.reduce((a, s) => a + s.runs, 0);
  const tokens = bySkill.reduce((a, s) => a + s.tokens, 0);
  const spend = bySkill.reduce((a, s) => a + s.spend, 0);
  const peak = Math.max(...days.map((d) => d.spend), 1);
  const topSpend = Math.max(...bySkill.map((s) => s.spend), 1);
  const budget = PLACEHOLDER_BUDGET;
  const used = budget.spent / budget.limit;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Date range" options={RANGES} value={range} onChange={setRange} />
        <span className="text-[0.8125rem] text-[var(--muted)]">Anthropic API usage for Cost Intelligence runs</span>
      </div>

      <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
        <Stat label="Runs" value={runs.toLocaleString("en-US")} />
        <Stat label="Tokens" value={millions(tokens)} />
        <Stat label="Spend" value={dollars(spend)} />
        <Stat label="Average per run" value={cents(spend / Math.max(runs, 1))} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card>
          <div className="flex items-baseline justify-between">
            <Label>Spend per day</Label>
            <span className="text-[0.75rem] text-[var(--muted)]">Hover a bar for the amount</span>
          </div>
          <div className="flex h-44 items-end gap-[3px]">
            {days.map((d) => (
              <div
                key={d.date}
                title={`${d.date}: ${dollars(d.spend)}`}
                className="flex-1 rounded-t-sm opacity-80 hover:opacity-100"
                style={{ height: `${(d.spend / peak) * 100}%`, minHeight: 2, background: "var(--module-accent)" }}
              />
            ))}
          </div>
          <div className="mt-2 flex justify-between text-[0.75rem] text-[var(--muted)]">
            <span>{days[0]?.date}</span>
            <span>Today</span>
          </div>
        </Card>

        <Card className="flex flex-col">
          <Label>{budget.month} budget</Label>
          <p className="text-2xl font-semibold">
            {dollars(budget.spent)}{" "}
            <span className="text-[0.8125rem] font-normal text-[var(--muted)]">of {dollars(budget.limit)}</span>
          </p>
          <div className="relative mt-4 h-2 rounded-full bg-[var(--neutral-100)]">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.min(used, 1) * 100}%`, background: "var(--module-accent)" }}
            />
            <span
              aria-hidden="true"
              className="absolute -top-1 h-4 w-0.5 rounded bg-[var(--neutral-700)]"
              style={{ left: `${budget.alertAt * 100}%` }}
            />
          </div>
          <p className="mt-3 text-[0.8125rem] text-[var(--muted)]">
            {Math.round(used * 100)}% used. You get an alert at {Math.round(budget.alertAt * 100)}%. Runs are not stopped
            at the limit.
          </p>
          <div className="mt-auto pt-5">
            <Button>Change budget</Button>
          </div>
        </Card>
      </div>

      <Card padding="p-0">
        <div className="grid grid-cols-[minmax(0,1fr)_5rem_6rem_6rem_5rem] gap-4 border-b border-[var(--divider-soft)] px-5 py-3">
          <span className="eyebrow text-[var(--muted)]">By skill</span>
          {["Runs", "Tokens", "Spend", "Per run"].map((h) => (
            <span key={h} className="eyebrow text-right text-[var(--muted)]">
              {h}
            </span>
          ))}
        </div>
        {bySkill.map((s) => (
          <div
            key={s.skill}
            className="grid grid-cols-[minmax(0,1fr)_5rem_6rem_6rem_5rem] items-center gap-4 border-b border-[var(--divider-soft)] px-5 py-3 text-[0.8125rem] last:border-b-0"
          >
            <span className="flex min-w-0 items-center gap-4">
              <span className="truncate font-mono text-[0.75rem]">{s.skill}</span>
              <span className="hidden h-1.5 w-40 shrink-0 rounded-full bg-[var(--neutral-100)] sm:block">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${(s.spend / topSpend) * 100}%`, background: "var(--module-accent)" }}
                />
              </span>
            </span>
            <span className="text-right tabular-nums">{s.runs}</span>
            <span className="text-right tabular-nums">{millions(s.tokens)}</span>
            <span className="text-right font-semibold tabular-nums">{dollars(s.spend)}</span>
            <span className="text-right tabular-nums text-[var(--muted)]">{cents(s.spend / Math.max(s.runs, 1))}</span>
          </div>
        ))}
      </Card>
    </div>
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

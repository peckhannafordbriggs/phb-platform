"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { MAX_CEILING_MINUTES, MAX_CEILING_USD, describeSafetyCeiling, type SafetyCeilingView } from "@/lib/modules/bas/reports/ceiling";
import type { ReportsUsage } from "@/lib/modules/bas/reports/usage";
import { USAGE_RANGE_OPTIONS } from "@/lib/usage/range";
import { Button, Card, INPUT, Label, Segmented, SpendPerDayChart, Table, UsageBreakdownTable, UsageStat, formatMoney, formatTokens } from "@/components/ui";
import { ApiError } from "./health-client";
import { setSafetyCeiling } from "./reports-client";
import { RunStatusChip } from "./reports-generated";
import { TONE_STYLE } from "./tone";

type Breakdown = "byReport" | "byBuilding";
const BREAKDOWNS: { value: Breakdown; label: string }[] = [
  { value: "byReport", label: "By report" },
  { value: "byBuilding", label: "By building" },
];

const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

/**
 * Usage - the Reports bar's fourth item (2026-11-12), on the same pieces
 * as Cost Intelligence's Usage & cost: the range, five tiles, spend per
 * day, a breakdown by report or by building, the most expensive runs, and
 * at the bottom the module's one safety ceiling, which a module admin can
 * change here and nobody can change anywhere else.
 *
 * Every figure is the service's over the runs the viewer may see; the
 * joinless count beside them is the guard every BAS list carries. Pure in
 * its props, so a node test can render it with a run and assert the page
 * no longer says there have been none.
 */
export function ReportsUsageView({ usage, canAdminister }: { usage: ReportsUsage; canAdminister: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [breakdown, setBreakdown] = useState<Breakdown>("byReport");
  const { totals, days } = usage;

  return (
    <div className={"flex flex-col gap-5 " + (pending ? "opacity-60" : "")} data-testid="reports-usage">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Date range"
          tone="accent"
          options={USAGE_RANGE_OPTIONS}
          value={usage.range}
          onChange={(range) => startTransition(() => router.push(`?range=${range}`))}
        />
        <span className="text-[0.8125rem] text-[var(--muted)]">
          Claude spend metered onto finished runs. The hard limit is the Anthropic Console spend limit.
        </span>
      </div>

      {totals.runs !== usage.runsInDatabase && (
        <p className="rounded-[var(--radius-row)] border p-3 text-sm" style={TONE_STYLE.bad} role="alert">
          These figures cover {totals.runs} of the {usage.runsInDatabase} finished runs you may see in this range. Report this.
        </p>
      )}

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
          <p className="py-6 text-center text-[0.8125rem] text-[var(--muted)]">No finished runs in this range.</p>
        ) : (
          <Table
            headers={["Run", "Report", "Building", "Status", "Started", "Spend"]}
            rows={usage.topRuns.map((r) => [
              <span key="id" className="font-mono text-[0.75rem]">{`#${r.runId}`}</span>,
              <span key="r" className="truncate">{r.reportName}</span>,
              <span key="b" className="truncate">{r.buildingName}</span>,
              <RunStatusChip key="s" status={r.status} />,
              WHEN.format(new Date(r.startedAt ?? r.finishedAt)),
              <span key="c" className="font-semibold tabular-nums">{formatMoney(r.spend)}</span>,
            ])}
            onRowClick={(i) => router.push(`/bas/reports/generated/${encodeURIComponent(usage.topRuns[i]!.runId)}`)}
          />
        )}
      </Card>

      <SafetyCeilingCard ceiling={usage.ceiling} canAdminister={canAdminister} onSaved={() => router.refresh()} />
    </div>
  );
}

/**
 * The module's safety ceiling: shown to everyone, edited by module admins.
 * One card, two numbers, one sentence on what reaching it does.
 */
export function SafetyCeilingCard({
  ceiling,
  canAdminister,
  onSaved,
}: {
  ceiling: SafetyCeilingView;
  canAdminister: boolean;
  onSaved?: () => void;
}) {
  const [usd, setUsd] = useState(ceiling.usd.toFixed(2));
  const [minutes, setMinutes] = useState(String(ceiling.minutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const save = async () => {
    const nextUsd = Number(usd);
    const nextMinutes = Number(minutes);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await setSafetyCeiling({
        ...(Number.isFinite(nextUsd) && Math.round(nextUsd * 100) / 100 !== ceiling.usd ? { ceilingUsd: Math.round(nextUsd * 100) / 100 } : {}),
        ...(Number.isInteger(nextMinutes) && nextMinutes !== ceiling.minutes ? { ceilingMinutes: nextMinutes } : {}),
      });
      setNotice(result.changed ? `Saved: ${describeSafetyCeiling(result.ceiling)}.` : "Nothing changed.");
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const dirty = Number(usd) !== ceiling.usd || Number(minutes) !== ceiling.minutes;

  return (
    <Card className="max-w-2xl">
      <Label>Safety ceiling</Label>
      <p className="text-sm">
        <span className="font-medium">{describeSafetyCeiling(ceiling)}</span>, for every report in the module.
      </p>
      <p className="mt-1 text-sm text-[var(--muted)]">
        A run that reaches it finishes partial and says so: past the dollars, the remaining sections show their evidence without
        narrative; past the minutes, the questions still waiting are skipped and named. Nothing is aborted and nothing is lost.
        {ceiling.updatedBy !== null && ceiling.updatedAt !== null
          ? ` Last set by ${ceiling.updatedBy} on ${ceiling.updatedAt.slice(0, 10)}.`
          : " The defaults, which nobody has changed."}
      </p>
      {canAdminister ? (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-[0.75rem] text-[var(--muted)]">Dollars per run</span>
            <input className={INPUT + " mt-1 w-28"} inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} aria-label="Ceiling in dollars per run" />
          </label>
          <label className="text-sm">
            <span className="block text-[0.75rem] text-[var(--muted)]">Minutes per run (1 to {MAX_CEILING_MINUTES})</span>
            <input className={INPUT + " mt-1 w-28"} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Ceiling in minutes per run" />
          </label>
          <Button disabled={busy || !dirty} onClick={() => void save()}>
            Save ceiling
          </Button>
          <span className="text-xs text-[var(--muted)]">At most ${MAX_CEILING_USD.toLocaleString("en-US")} and {MAX_CEILING_MINUTES} minutes. Module admins only.</span>
        </div>
      ) : (
        <p className="mt-2 text-xs text-[var(--muted)]">Changed by BAS module admins, here.</p>
      )}
      {error !== null && (
        <p className="mt-3 rounded-[var(--radius-row)] border p-3 text-sm" style={TONE_STYLE.bad} role="alert">
          {error}
        </p>
      )}
      {notice !== null && (
        <p className="mt-3 rounded-[var(--radius-row)] border p-3 text-sm" style={TONE_STYLE.ok} role="status">
          {notice}
        </p>
      )}
    </Card>
  );
}

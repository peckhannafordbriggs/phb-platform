import type { UsageDay, UsageRow } from "@/lib/usage/range";
import { Card } from "./Card";
import { Label } from "./Label";

/**
 * The pieces of a "Usage & cost" page (2026-11-12), promoted from Cost
 * Intelligence's usage view when the BAS Reports Usage page was built on
 * them: a stat tile, the spend-per-day bars, and the breakdown table with
 * its proportion bar. Each takes the shapes in lib/usage/range.ts and
 * nothing module-specific; the bars and the proportion read
 * `--module-accent`, so the same chart is teal in Cost Intelligence and
 * cyan in Building Automation without either module saying so.
 */

export const formatMoney = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
export const formatTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);

export function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <Label>{label}</Label>
      <p className="text-3xl font-semibold tabular-nums">{value}</p>
    </Card>
  );
}

/** One bar per calendar day, oldest first, scaled to the busiest day. */
export function SpendPerDayChart({ days }: { days: UsageDay[] }) {
  const peak = Math.max(...days.map((d) => d.spend), 0);
  return (
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
              title={`${d.label}: ${formatMoney(d.spend)}`}
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
  );
}

const COLUMNS = "grid-cols-[minmax(0,1fr)_4rem_5rem_6rem_5rem]";

/** Rows with runs, tokens, spend and per-run, each with a bar proportional to the top spender. */
export function UsageBreakdownTable({ rows }: { rows: UsageRow[] }) {
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
          <span className="text-right tabular-nums">{formatTokens(r.tokens)}</span>
          <span className="text-right font-semibold tabular-nums">{formatMoney(r.spend)}</span>
          <span className="text-right tabular-nums text-[var(--muted)]">{formatMoney(r.spend / Math.max(r.runs, 1))}</span>
        </div>
      ))}
    </>
  );
}

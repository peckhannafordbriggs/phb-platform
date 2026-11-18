"use client";

import { useEffect, useState } from "react";
import type { TrendCalendar, TrendRange } from "@/lib/modules/bas/types";
import { compareCalendarDates, yearRange } from "@/lib/modules/bas/range";
import { FieldLabel, INPUT, Segmented } from "@/components/ui";
import { WINDOW_PRESETS, formatCalendarDate } from "./health-client";

/**
 * The Point Explorer's time range: the three presets, a Custom pair of dates,
 * and one button per calendar year that holds readings (2026-09-22).
 *
 * The dates travel as `YYYY-MM-DD` text and PostgreSQL resolves them against
 * the building's time zone - midnight to midnight where the building is, end
 * exclusive - so the form says which zone it means and where the data begins.
 * A draft that cannot be a range (end before start, end in the future) is
 * refused here, with the reason, before anything is asked of the server.
 *
 * The strips are the kit's Segmented in the platform accent, announcing
 * themselves as toggle groups as they always have (2026-11-10).
 */
export function RangePicker({
  range,
  calendar,
  onPreset,
  onCustom,
}: {
  range: TrendRange;
  calendar: TrendCalendar | null;
  onPreset: (days: number) => void;
  onCustom: (from: string, to: string) => void;
}) {
  const isCustom = range.kind === "custom";
  const [open, setOpen] = useState(isCustom);

  const seedFrom = range.fromDate ?? calendar?.latestDate ?? calendar?.today ?? "";
  const seedTo = range.toDate ?? calendar?.latestDate ?? calendar?.today ?? "";
  const [from, setFrom] = useState(seedFrom);
  const [to, setTo] = useState(seedTo);

  useEffect(() => {
    if (range.fromDate !== null && range.toDate !== null) {
      setFrom(range.fromDate);
      setTo(range.toDate);
      setOpen(true);
    }
  }, [range.fromDate, range.toDate]);

  const today = calendar?.today ?? null;
  const problem = describeDraftProblem(from, to, today);

  const pressedYear = (): string => {
    if (!isCustom || today === null) return "";
    for (const year of calendar?.years ?? []) {
      const span = yearRange(year, today);
      if (range.fromDate === span.from && range.toDate === span.to) return String(year);
    }
    return "";
  };

  const rangeValue = isCustom ? "custom" : range.kind === "preset" ? String(range.days) : "";

  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-[var(--muted)]">Range</span>
        <Segmented
          semantics="pressed"
          tone="accent"
          label="Time range"
          options={[
            ...WINDOW_PRESETS.map((preset) => ({ value: String(preset.days), label: preset.label })),
            { value: "custom", label: "Custom" },
          ]}
          value={rangeValue}
          onChange={(next) => {
            if (next === "custom") setOpen((value) => !value || !isCustom);
            else onPreset(Number(next));
          }}
        />
      </div>

      {calendar !== null && calendar.years.length > 0 && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-[var(--muted)]">Year</span>
          <Segmented
            semantics="pressed"
            tone="accent"
            label="Calendar year"
            options={calendar.years.map((year) => ({ value: String(year), label: String(year) }))}
            value={pressedYear()}
            onChange={(next) => {
              const span = yearRange(Number(next), calendar.today);
              onCustom(span.from, span.to);
            }}
          />
        </div>
      )}

      {open && (
        <form
          id="bas-custom-range"
          className="flex w-full flex-wrap items-end gap-3 rounded-[var(--radius-row)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (problem === null && from.length > 0 && to.length > 0) {
              onCustom(from, to);
            }
          }}
        >
          <FieldLabel label="Start">
            <input
              type="date"
              value={from}
              max={today ?? undefined}
              onChange={(event) => setFrom(event.target.value)}
              className={INPUT + " w-40 font-mono"}
              aria-label="Start date"
              required
            />
          </FieldLabel>
          <FieldLabel label="End">
            <input
              type="date"
              value={to}
              max={today ?? undefined}
              onChange={(event) => setTo(event.target.value)}
              className={INPUT + " w-40 font-mono"}
              aria-label="End date"
              required
            />
          </FieldLabel>
          {/* The kit's shape in the module's own colour: the platform accent, as the strips above. */}
          <button
            type="submit"
            disabled={problem !== null || from.length === 0 || to.length === 0}
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--accent)] px-4 text-[0.8125rem] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Apply
          </button>

          <div className="basis-full text-xs text-[var(--muted)]">
            {problem !== null ? (
              <p role="alert" className="text-[var(--phb-maroon)]">
                {problem}
              </p>
            ) : (
              <p>
                {calendar === null
                  ? "Dates are calendar days in the building's time zone."
                  : `Dates are calendar days in ${calendar.timezone}, the building's time zone. ` +
                    `A day runs from midnight to midnight there, so the start and end days are included whole. ` +
                    (calendar.earliestDate === null
                      ? ""
                      : `Readings begin ${formatCalendarDate(calendar.earliestDate)}.`)}
              </p>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * Why a draft pair of dates cannot be asked for, or null when it can. Pure, so
 * the two refusals are tested without a screen.
 */
export function describeDraftProblem(
  from: string,
  to: string,
  today: string | null,
): string | null {
  if (from.length === 0 || to.length === 0) return null;
  if (compareCalendarDates(to, from) < 0) {
    return `The end date (${formatCalendarDate(to)}) is before the start date (${formatCalendarDate(from)}).`;
  }
  if (today !== null && compareCalendarDates(to, today) > 0) {
    return `The end date (${formatCalendarDate(to)}) is in the future. Today in the building's time zone is ${formatCalendarDate(today)}.`;
  }
  return null;
}

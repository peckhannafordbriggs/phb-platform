"use client";

import { useEffect, useState } from "react";
import type { TrendCalendar, TrendRange } from "@/lib/modules/bas/types";
import { compareCalendarDates, yearRange } from "@/lib/modules/bas/range";
import { WINDOW_PRESETS, formatCalendarDate } from "./health-client";

/**
 * The time range control: three presets, Custom, and one button per calendar
 * year that actually holds readings.
 *
 * THE DATES ARE THE BUILDING'S. A person typing 14 August means 14 August
 * where the sensor is. The two `<input type="date">` fields produce
 * `YYYY-MM-DD` text and that text goes into the URL and to the server
 * unchanged; nothing here turns it into a Date, because a JavaScript Date is
 * in the browser's zone and that is precisely the zone the request is not
 * about. The zone the dates belong to is written under the fields.
 *
 * The year buttons come from `calendar.years`, which the server derives from
 * the earliest and latest reading the viewer may see. No readings in 2023, no
 * 2023 button. The current year's shortcut ends today rather than on 31
 * December, because an end in the future is refused and a shortcut that
 * produced a refusal would be a broken button.
 *
 * Native date inputs, on purpose: they open the browser's own calendar, they
 * are keyboard-operable, and they add no dependency to a page that has none.
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

  // The draft the fields hold. Seeded from the range on screen, or from the
  // last day with data so the calendar opens where the readings are.
  const seedFrom = range.fromDate ?? calendar?.latestDate ?? calendar?.today ?? "";
  const seedTo = range.toDate ?? calendar?.latestDate ?? calendar?.today ?? "";
  const [from, setFrom] = useState(seedFrom);
  const [to, setTo] = useState(seedTo);

  // A range applied from a year button, or a bookmark, arrives from outside:
  // the fields follow it rather than showing a stale draft.
  useEffect(() => {
    if (range.fromDate !== null && range.toDate !== null) {
      setFrom(range.fromDate);
      setTo(range.toDate);
      setOpen(true);
    }
  }, [range.fromDate, range.toDate]);

  const today = calendar?.today ?? null;
  const problem = describeDraftProblem(from, to, today);

  const yearPressed = (year: number): boolean => {
    if (!isCustom || today === null) return false;
    const span = yearRange(year, today);
    return range.fromDate === span.from && range.toDate === span.to;
  };

  const segment =
    "border-l border-[var(--border)] px-2.5 py-1 text-sm first:border-l-0 ";
  const pressed = "bg-[var(--accent)] text-white";
  const idle = "bg-white hover:bg-[var(--surface)]";

  return (
    <div className="flex flex-wrap items-start gap-3">
      <div
        className="flex items-center gap-2 text-sm"
        role="group"
        aria-label="Time range"
      >
        <span className="text-[var(--muted)]">Range</span>
        <div className="flex overflow-hidden rounded border border-[var(--border)]">
          {WINDOW_PRESETS.map((preset) => {
            const on = range.kind === "preset" && range.days === preset.days;
            return (
              <button
                key={preset.days}
                type="button"
                aria-pressed={on}
                onClick={() => onPreset(preset.days)}
                className={segment + (on ? pressed : idle)}
              >
                {preset.label}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={isCustom}
            aria-expanded={open}
            aria-controls="bas-custom-range"
            onClick={() => setOpen((value) => !value || !isCustom)}
            className={segment + (isCustom ? pressed : idle)}
          >
            Custom
          </button>
        </div>
      </div>

      {calendar !== null && calendar.years.length > 0 && (
        <div
          className="flex items-center gap-2 text-sm"
          role="group"
          aria-label="Calendar year"
        >
          <span className="text-[var(--muted)]">Year</span>
          <div className="flex overflow-hidden rounded border border-[var(--border)]">
            {calendar.years.map((year) => {
              const on = yearPressed(year);
              return (
                <button
                  key={year}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    const span = yearRange(year, calendar.today);
                    onCustom(span.from, span.to);
                  }}
                  className={segment + (on ? pressed : idle)}
                >
                  {year}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {open && (
        <form
          id="bas-custom-range"
          className="flex w-full flex-wrap items-end gap-3 rounded border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (problem === null && from.length > 0 && to.length > 0) {
              onCustom(from, to);
            }
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
            Start
            <input
              type="date"
              value={from}
              max={today ?? undefined}
              onChange={(event) => setFrom(event.target.value)}
              className="rounded border border-[var(--border)] bg-white px-2 py-1 text-sm text-[var(--foreground)]"
              aria-label="Start date"
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
            End
            <input
              type="date"
              value={to}
              max={today ?? undefined}
              onChange={(event) => setTo(event.target.value)}
              className="rounded border border-[var(--border)] bg-white px-2 py-1 text-sm text-[var(--foreground)]"
              aria-label="End date"
              required
            />
          </label>
          <button
            type="submit"
            disabled={problem !== null || from.length === 0 || to.length === 0}
            className="rounded border border-[var(--accent)] bg-[var(--accent)] px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
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
 * The two things a person can get wrong before the server is asked, in
 * words. `null` when the draft is fine. The server checks both again, in the
 * building's zone, and the third thing - a day that does not exist - which a
 * date input cannot produce.
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

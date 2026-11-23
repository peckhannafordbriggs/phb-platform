"use client";

import { useMemo, useRef, useState } from "react";
import type { PointExplorer as PointExplorerData, PointOption } from "@/lib/modules/bas/types";
import {
  MAX_CHART_LINES,
  addRefusal,
  describeAddRefusal,
  lineStyle,
  type LineIdentity,
} from "@/lib/modules/bas/chart-lines";
import { unitSymbol } from "@/lib/modules/bas/units";
import { NO_POINT } from "@/lib/modules/bas/constants";
import { Button, Dropdown, MultiSelect, SearchBar, type DropdownOption } from "@/components/ui";
import { ALL_SITES } from "./filters";
import { ApiError, fetchPointExplorer, formatCount, stationPickerOptions } from "./health-client";

/**
 * Point Explorer's picker (2026-11-20). The Point dropdown it replaces listed
 * every point on the JACE in one column - 334 of them on CEI_JCI_N2 - and
 * matched only on a first letter.
 *
 * Three pieces, each pure in its props so a test drives it with a list:
 *
 *  - the Equipment multi-select, after the JACE: the equipment the listed
 *    points are on, with its type and how many points, plus "Unclassified
 *    (no equipment)". None chosen means every point, so a small station is
 *    no worse off than it was;
 *  - the Point list: the points of the chosen equipment, grouped by it, the
 *    role beside each name, narrowed by typing any part of a name or role.
 *    Choosing one opens it, as the dropdown did; "Tick several" puts a box
 *    on every row and "Plot selected" draws the ticked set as one chart;
 *  - the Add point panel: the same list behind its own Project, Building and
 *    JACE, for adding one line from anywhere the viewer may see.
 *
 * What the equipment selection and the search hold is the picker's working
 * state, not the chart's, and stays out of the URL; the lines are the URL.
 */

/** The Equipment entry for points on no equipment. Not a number, so never an equipment id. */
export const UNCLASSIFIED = "unclassified";
export const UNCLASSIFIED_LABEL = "Unclassified (no equipment)";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
/** VAV-2 before VAV-10, V4_9 before V4_22: names as a person counts them. */
export const naturalCompare = (a: string, b: string): number => collator.compare(a, b);

export interface EquipmentOption {
  /** The equipment id, or UNCLASSIFIED. */
  value: string;
  name: string;
  /** "VAV Box" - the vocabulary's word for its type - or null. */
  type: string | null;
  /** Shown points on it in the list the picker was given. */
  count: number;
  /** Set only when the list spans buildings, where two buildings may each have an AHU-1. */
  siteName: string | null;
}

/**
 * The Equipment options: every equipment a listed point is on, by name as a
 * person counts, then Unclassified when any point is on none. Built from the
 * points rather than the equipment table, so the count is what the list will
 * show and an equipment with nothing shown on it is not offered.
 */
export function equipmentOptions(points: readonly PointOption[]): EquipmentOption[] {
  const sites = new Set(points.map((p) => p.siteName));
  const byId = new Map<string, EquipmentOption>();
  let unclassified = 0;
  for (const p of points) {
    if (p.equipmentId === null) {
      unclassified += 1;
      continue;
    }
    const entry = byId.get(p.equipmentId);
    if (entry !== undefined) entry.count += 1;
    else
      byId.set(p.equipmentId, {
        value: p.equipmentId,
        name: p.equipmentName ?? `Equipment ${p.equipmentId}`,
        type: p.equipmentType,
        count: 1,
        siteName: sites.size > 1 ? p.siteName : null,
      });
  }
  const list = [...byId.values()].sort(
    (a, b) => naturalCompare(a.name, b.name) || naturalCompare(a.siteName ?? "", b.siteName ?? ""),
  );
  if (unclassified > 0) {
    list.push({ value: UNCLASSIFIED, name: UNCLASSIFIED_LABEL, type: null, count: unclassified, siteName: null });
  }
  return list;
}

const pointsWord = (n: number) => `${formatCount(n)} point${n === 1 ? "" : "s"}`;

/** "VAV Box · 12 points", the site added when the list spans buildings. */
export function describeEquipment(option: EquipmentOption): string {
  return [option.siteName, option.value === UNCLASSIFIED ? null : (option.type ?? "no type"), pointsWord(option.count)]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/**
 * A point matches when every word typed appears somewhere in its name or its
 * role: "v4_22 temp" finds V4_22/SpaceTemp and V4_22/SpaceTempSp, "zone_temp"
 * finds every point with that role whatever it is called.
 */
export function matchesQuery(point: Pick<PointOption, "pointName" | "pointRole">, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return true;
  const hay = `${point.pointName} ${point.pointRole ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export interface PointGroup {
  /** The equipment id, or UNCLASSIFIED. */
  key: string;
  name: string;
  type: string | null;
  siteName: string | null;
  points: PointOption[];
}

/**
 * The Point list: the points on the chosen equipment (every point when none
 * is chosen), narrowed by the search, grouped by equipment in the Equipment
 * list's order, each group's points by name as a person counts.
 */
export function filterPointGroups(
  points: readonly PointOption[],
  filter: { equipment: readonly string[]; query: string },
): PointGroup[] {
  const options = equipmentOptions(points);
  const wanted = new Set(filter.equipment);
  const groups = new Map<string, PointGroup>(
    options.map((o) => [o.value, { key: o.value, name: o.name, type: o.type, siteName: o.siteName, points: [] }]),
  );
  for (const p of points) {
    const key = p.equipmentId ?? UNCLASSIFIED;
    if (wanted.size > 0 && !wanted.has(key)) continue;
    if (!matchesQuery(p, filter.query)) continue;
    groups.get(key)?.points.push(p);
  }
  return [...groups.values()]
    .filter((g) => g.points.length > 0)
    .map((g) => ({ ...g, points: [...g.points].sort((a, b) => naturalCompare(a.pointName, b.pointName)) }));
}

/** The axis rule's view of a point (chart-lines.ts). */
export function lineIdentity(point: PointOption): LineIdentity {
  return { pointId: point.pointId, valueKind: point.valueKind, unit: point.unit, states: point.states };
}

// ------------------------------------------------------------- Equipment

/** The Equipment multi-select, over the points the picker was given. */
export function EquipmentSelect({
  points,
  value,
  onChange,
  className = "min-w-64 max-w-md",
}: {
  points: readonly PointOption[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  className?: string;
}) {
  const options = useMemo(() => equipmentOptions(points), [points]);
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-[var(--muted)]">Equipment</span>
      <MultiSelect
        label="Equipment"
        placeholder={options.length === 0 ? "No equipment" : "All equipment"}
        searchPlaceholder="Search equipment"
        options={options.map((o) => ({ value: o.value, label: o.name, hint: describeEquipment(o) }))}
        value={value}
        onChange={onChange}
        disabled={options.length === 0}
        className={className}
        testId="bas-equipment-select"
      />
    </div>
  );
}

/**
 * Keeps an equipment selection to the options there are. A JACE change leaves
 * ids from the old station behind; those are dropped rather than left to
 * filter the new list to nothing.
 */
export function pruneEquipment(value: readonly string[], points: readonly PointOption[]): string[] {
  const there = new Set(equipmentOptions(points).map((o) => o.value));
  return value.filter((v) => there.has(v));
}

// ------------------------------------------------------------- the list

/** The swatch a line wears in the legend, and beside a plotted point in the list. */
export function LineSwatch({ slot }: { slot: number }) {
  const style = lineStyle(slot);
  return (
    <svg aria-hidden="true" width="20" height="6" className="inline-block shrink-0">
      <line x1="0" y1="3" x2="20" y2="3" stroke={style.stroke} strokeWidth="2" strokeDasharray={style.dash} />
    </svg>
  );
}

export function PointList({
  points,
  equipment,
  onPick,
  plotted = [],
  slotOf,
  refusal,
  onPlot,
  hotkey = false,
  emptyText = "No points.",
}: {
  points: readonly PointOption[];
  /** The Equipment selection. Empty is every point. */
  equipment: readonly string[];
  /** One point chosen: the main list opens it; the Add panel adds it. */
  onPick: (pointId: string) => void;
  /** The lines on the chart, in slot order. Marked in the list; tick mode starts from them. */
  plotted?: readonly PointOption[];
  /** A plotted point's slot, for its swatch. */
  slotOf?: (pointId: string) => number | null;
  /** Why a point cannot be chosen here, or null. The Add panel's rule. */
  refusal?: (point: PointOption) => string | null;
  /** Present on the main list: enables "Tick several" and receives the ticked ids. */
  onPlot?: (pointIds: string[]) => void;
  hotkey?: boolean;
  emptyText?: string;
}) {
  const [query, setQuery] = useState("");
  const [ticking, setTicking] = useState(false);
  const [ticked, setTicked] = useState<PointOption[]>([]);
  const groups = useMemo(() => filterPointGroups(points, { equipment, query }), [points, equipment, query]);
  const shown = groups.reduce((n, g) => n + g.points.length, 0);
  const tickedIds = new Set(ticked.map((p) => p.pointId));
  const tickedIdentities = ticked.map(lineIdentity);

  const startTicking = () => {
    setTicked([...plotted]);
    setTicking(true);
  };
  const flip = (point: PointOption) =>
    setTicked((current) =>
      current.some((p) => p.pointId === point.pointId)
        ? current.filter((p) => p.pointId !== point.pointId)
        : [...current, point],
    );
  const tickRefusal = (point: PointOption): string | null => {
    if (tickedIds.has(point.pointId)) return null;
    const reason = addRefusal(tickedIdentities, lineIdentity(point));
    return reason === null || reason === "on_chart" ? null : describeAddRefusal(reason, tickedIdentities);
  };

  return (
    <div data-testid="bas-point-list" data-ticking={ticking ? "true" : "false"}>
      <div className="flex flex-wrap items-center gap-3 px-4 pb-2">
        <SearchBar
          label="Search points by name or role"
          placeholder="Search by name or role"
          value={query}
          onChange={setQuery}
          hotkey={hotkey}
          className="w-72"
        />
        <span className="text-xs text-[var(--muted)]" data-testid="bas-point-list-count">
          {shown === points.length ? pointsWord(points.length) : `${formatCount(shown)} of ${pointsWord(points.length)}`}
        </span>
        {onPlot !== undefined && (
          <span className="ml-auto">
            {ticking ? (
              <Button size="sm" onClick={() => setTicking(false)} testId="bas-tick-cancel">
                Cancel
              </Button>
            ) : (
              <Button size="sm" onClick={startTicking} testId="bas-tick-several" title="Tick points to plot them together, up to six">
                Tick several
              </Button>
            )}
          </span>
        )}
      </div>

      {groups.length === 0 ? (
        <p className="px-4 pb-4 pt-2 text-sm text-[var(--muted)]" data-testid="bas-point-list-empty">
          {points.length === 0 ? emptyText : "No point matches."}
        </p>
      ) : (
        <div className="max-h-80 overflow-auto border-t border-[var(--divider-soft)]">
          {groups.map((group) => (
            <section key={group.key} data-testid="bas-point-group" data-group={group.key}>
              <h3 className="sticky top-0 z-10 flex items-baseline gap-2 bg-[var(--surface)] px-4 py-1.5 text-xs">
                <span className="font-medium text-[var(--foreground)]">{group.name}</span>
                <span className="text-[var(--muted)]">
                  {[group.siteName, group.key === UNCLASSIFIED ? null : group.type, pointsWord(group.points.length)]
                    .filter((part): part is string => part !== null)
                    .join(" · ")}
                </span>
              </h3>
              <ul>
                {group.points.map((point) => {
                  const slot = slotOf?.(point.pointId) ?? null;
                  const refused = ticking ? tickRefusal(point) : (refusal?.(point) ?? null);
                  const isTicked = tickedIds.has(point.pointId);
                  const body = (
                    <>
                      <span className="truncate">{point.pointName}</span>
                      <span className="shrink-0 text-xs text-[var(--muted)]">{point.pointRole ?? "role not set"}</span>
                      {slot !== null && !ticking && (
                        <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-[var(--muted)]">
                          <LineSwatch slot={slot} /> on the chart
                        </span>
                      )}
                      {refused !== null && (
                        <span className="ml-auto shrink-0 text-xs text-[var(--muted)]">{refused}</span>
                      )}
                    </>
                  );
                  return (
                    <li key={point.pointId} className="border-t border-[var(--divider-soft)] first:border-t-0">
                      {ticking ? (
                        <label
                          className={
                            "flex items-center gap-2.5 px-4 py-1.5 text-[0.8125rem] " +
                            (refused !== null ? "opacity-60" : "cursor-pointer hover:bg-[var(--neutral-50)]")
                          }
                          title={refused ?? undefined}
                        >
                          <input
                            type="checkbox"
                            checked={isTicked}
                            disabled={refused !== null}
                            onChange={() => flip(point)}
                            aria-label={`Tick ${point.pointName}`}
                            data-testid="bas-point-tick"
                            className="h-4 w-4 shrink-0 accent-[var(--foreground)]"
                          />
                          {body}
                        </label>
                      ) : (
                        <button
                          type="button"
                          disabled={refused !== null}
                          onClick={() => onPick(point.pointId)}
                          title={refused ?? `${point.pointName} · ${unitSymbol(point.unit) ?? (point.valueKind === "boolean" ? "on / off" : "no unit recorded")}`}
                          className={
                            "flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-[0.8125rem] disabled:cursor-default disabled:opacity-60 " +
                            (slot !== null ? "font-medium " : "") +
                            "enabled:hover:bg-[var(--neutral-50)]"
                          }
                          data-testid="bas-point-option"
                          data-point={point.pointId}
                        >
                          {body}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {ticking && onPlot !== undefined && (
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--divider-soft)] px-4 py-2.5" data-testid="bas-tick-footer">
          <span className="text-xs text-[var(--muted)]">
            {ticked.length === 0 ? "Nothing ticked." : `Ticked ${ticked.length} of ${MAX_CHART_LINES}:`}
          </span>
          {ticked.map((p, i) => (
            <span key={p.pointId} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[var(--neutral-100)] pl-2.5 pr-1 text-xs" data-testid="bas-ticked-chip">
              <LineSwatch slot={i} />
              <span className="max-w-[14rem] truncate">{p.pointName}</span>
              <button
                type="button"
                aria-label={`Untick ${p.pointName}`}
                onClick={() => flip(p)}
                className="rounded-full px-1 text-[var(--muted)] hover:bg-[var(--neutral-200)] hover:text-[var(--foreground)]"
              >
                ×
              </button>
            </span>
          ))}
          <span className="ml-auto text-xs text-[var(--muted)]">The first ticked is the one the tiles describe.</span>
          <Button
            size="sm"
            variant="primary"
            disabled={ticked.length === 0}
            onClick={() => {
              setTicking(false);
              onPlot(ticked.map((p) => p.pointId));
            }}
            testId="bas-plot-selected"
          >
            Plot selected{ticked.length === 0 ? "" : ` (${ticked.length})`}
          </Button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ Add point

/** One level of the Add panel's own cascade, the page's control with "All". */
function Level({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: DropdownOption[];
  onChange: (value: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-[var(--muted)]">{label}</span>
      <Dropdown
        label={`Add point: ${label}`}
        value={value ?? ALL_SITES}
        onChange={(next) => onChange(next === ALL_SITES ? null : next)}
        disabled={options.length === 0}
        options={[{ value: ALL_SITES, label: "All" }, ...options]}
        className="min-w-44"
      />
    </div>
  );
}

type Lists = Pick<
  PointExplorerData,
  "projects" | "sites" | "stations" | "points" | "selectedProjectId" | "selectedSiteId" | "selectedStationId"
>;

/**
 * "Add point": the whole picker - its own Project, Building and JACE, the
 * Equipment select, the search and the list - inside the trend panel, and
 * one click adds a line. Starts where the page is; a level changed here
 * fetches that scope's lists with no point loaded (`point=none`), and the
 * page's own cascade is untouched. A point that is already a line, or would
 * need a third axis, or would be a seventh line, is shown and not offered,
 * with the reason beside it.
 */
export function AddPointPanel({
  start,
  windowDays,
  lines,
  onAdd,
  onClose,
  load = fetchPointExplorer,
}: {
  start: Lists;
  windowDays: number;
  /** The lines on the chart, in slot order. */
  lines: readonly PointOption[];
  onAdd: (pointId: string) => void;
  onClose: () => void;
  /** Injected by a test. */
  load?: typeof fetchPointExplorer;
}) {
  const [lists, setLists] = useState<Lists>(start);
  const [equipment, setEquipment] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const identities = lines.map(lineIdentity);
  // Ids from a scope this panel has since left are dropped, not left to
  // filter the new list to nothing.
  const chosenEquipment = pruneEquipment(equipment, lists.points);

  async function choose(level: "project" | "site" | "station", value: string | null) {
    // A level clears every level below it, as the page's cascade does.
    const next = {
      projectId: level === "project" ? value : lists.selectedProjectId,
      siteId: level === "project" ? null : level === "site" ? value : lists.selectedSiteId,
      stationId: level === "station" ? value : null,
    };
    const mine = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const fetched = await load({ days: windowDays, pointId: NO_POINT, ...next });
      if (mine === request.current) setLists(fetched);
    } catch (caught) {
      if (mine === request.current) setError(caught instanceof ApiError ? caught.message : "That did not load.");
    } finally {
      if (mine === request.current) setLoading(false);
    }
  }

  const full = lines.length >= MAX_CHART_LINES;

  return (
    <div className="border-b border-[var(--divider-soft)] pb-1 pt-3" data-testid="bas-add-point">
      <div className="flex flex-wrap items-center gap-3 px-4 pb-3">
        <Level
          label="Project"
          value={lists.selectedProjectId}
          options={lists.projects.map((row) => ({ value: row.projectId, label: row.name }))}
          onChange={(v) => void choose("project", v)}
        />
        <Level
          label="Building"
          value={lists.selectedSiteId}
          options={lists.sites.map((row) => ({ value: row.siteId, label: row.name }))}
          onChange={(v) => void choose("site", v)}
        />
        <Level label="JACE" value={lists.selectedStationId} options={stationPickerOptions(lists.stations)} onChange={(v) => void choose("station", v)} />
        <EquipmentSelect points={lists.points} value={chosenEquipment} onChange={setEquipment} />
        <Button size="sm" onClick={onClose} className="ml-auto" testId="bas-add-point-close">
          Done
        </Button>
      </div>
      {error !== null && (
        <p className="mx-4 mb-2 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
      <p className="px-4 pb-2 text-xs text-[var(--muted)]">
        {full
          ? `The chart holds ${MAX_CHART_LINES} lines. Remove one from the legend to add another.`
          : loading
            ? "Loading…"
            : `Choose a point to add it as a line — ${lines.length} of ${MAX_CHART_LINES} on the chart.`}
      </p>
      <PointList
        points={lists.points}
        equipment={chosenEquipment}
        onPick={onAdd}
        plotted={lines}
        refusal={(point) => {
          const reason = addRefusal(identities, lineIdentity(point));
          return reason === null ? null : describeAddRefusal(reason, identities);
        }}
        emptyText="No points to add in this selection."
      />
    </div>
  );
}

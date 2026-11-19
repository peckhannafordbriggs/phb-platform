"use client";

import { useMemo } from "react";
import {
  equipmentKey,
  groupIncludedByDefault,
  type NamePrefixGroup,
} from "@/lib/modules/bas/name-prefix";
import type {
  EquipmentTypeOption,
  SettingsEquipment,
  SettingsPoint,
  SuggestionLevel,
} from "@/lib/modules/bas/types";
import { pointDisplayName } from "@/lib/modules/bas/types";
import { Button, INPUT, Pill } from "@/components/ui";
import { describeSuggestion } from "./health-client";
import { TONE_STYLE } from "./tone";

/**
 * The two previews on Settings -> Points that act on a whole station from
 * its point names (2026-11-19):
 *
 *   - "Apply all high-confidence suggestions": the rows it would change, each
 *     with a box, before one request applies the ticked ones;
 *   - "Create N pieces of equipment from name prefixes": one row per unit the
 *     names imply - prefix, the name it will get, its type, how many points -
 *     with the name and type editable, before one request creates and
 *     attaches the ticked ones.
 *
 * NOTHING HERE WRITES. Confirm hands the parent a selection; the parent
 * sends it; the server recomputes everything from the database and refuses
 * a preview it no longer matches. The pure helpers are exported so the rules
 * the buttons depend on are tested without a DOM.
 */

const EMPTY = <span className="text-[var(--muted)]">—</span>;
const noun = (n: number, one: string, many: string) => (n === 1 ? one : many);

// ----------------------------------------------------------- suggestions

/** The rows "Apply all high-confidence suggestions" offers: high, and nothing else. */
export function highConfidencePoints(points: readonly SettingsPoint[]): SettingsPoint[] {
  return points.filter((p) => p.suggestion !== null && p.suggestion.level === "high");
}

/** How many suggestions there are at each level, for the toolbar's sentence. */
export function suggestionLevels(points: readonly SettingsPoint[]): Record<SuggestionLevel, number> {
  const counts: Record<SuggestionLevel, number> = { high: 0, medium: 0 };
  for (const p of points) if (p.suggestion !== null) counts[p.suggestion.level] += 1;
  return counts;
}

/** The level as words on a row. Medium is the one that asks for a look. */
export function LevelPill({ level }: { level: SuggestionLevel }) {
  return level === "high" ? (
    <Pill tone="ok">High</Pill>
  ) : (
    <Pill tone="warn">Medium · check first</Pill>
  );
}

export function SuggestionsPreview({
  points,
  selected,
  onSelectionChange,
  onConfirm,
  onCancel,
  busy,
}: {
  /** highConfidencePoints(list.points). */
  points: readonly SettingsPoint[];
  selected: ReadonlySet<string>;
  onSelectionChange: (next: ReadonlySet<string>) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const toggle = (pointId: string) => {
    const next = new Set(selected);
    if (next.has(pointId)) next.delete(pointId);
    else next.add(pointId);
    onSelectionChange(next);
  };
  const creates = useMemo(() => {
    const names = new Map<string, string>();
    for (const p of points) {
      const s = p.suggestion;
      if (s === null || !selected.has(p.pointId)) continue;
      if (s.equipmentName !== null && s.equipmentId === null) {
        names.set(equipmentKey(s.equipmentName), s.equipmentName);
      }
    }
    return [...names.values()];
  }, [points, selected]);

  return (
    <div
      className="space-y-2 rounded-[var(--radius-control)] border p-3"
      style={TONE_STYLE.warn}
      role="dialog"
      aria-label="Review the high-confidence suggestions"
    >
      <p className="text-xs">
        {points.length} high-confidence {noun(points.length, "suggestion", "suggestions")} on this
        station. Untick any you do not want; nothing is written until you confirm, and a point that
        has been given a role or equipment since this list loaded is left as it is.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Button size="sm" disabled={busy} onClick={() => onSelectionChange(new Set(points.map((p) => p.pointId)))}>
          Tick all
        </Button>
        <Button size="sm" disabled={busy} onClick={() => onSelectionChange(new Set())}>
          Untick all
        </Button>
        <span aria-live="polite">{selected.size} ticked</span>
      </div>
      <div className="max-h-72 overflow-auto rounded-[var(--radius-row)] bg-[var(--surface)]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left text-[var(--muted)]">
            <tr>
              <th className="eyebrow py-2 pl-2 pr-3 text-[var(--muted)]">
                <span className="sr-only">Apply</span>
              </th>
              <th className="eyebrow py-2 pr-3 text-[var(--muted)]">Point</th>
              <th className="eyebrow py-2 pr-3 text-[var(--muted)]">Suggestion</th>
              <th className="eyebrow py-2 pr-3 text-[var(--muted)]">Why</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.pointId} className="border-t border-[var(--divider-soft)] align-top">
                <td className="py-2 pl-2 pr-3">
                  <input
                    type="checkbox"
                    checked={selected.has(point.pointId)}
                    disabled={busy}
                    aria-label={`Apply the suggestion to ${pointDisplayName(point)}`}
                    onChange={() => toggle(point.pointId)}
                  />
                </td>
                <td className="py-2 pr-3">{pointDisplayName(point)}</td>
                <td className="py-2 pr-3">{point.suggestion === null ? EMPTY : describeSuggestion(point.suggestion)}</td>
                <td className="py-2 pr-3 text-[var(--muted)]">{point.suggestion?.confidence ?? EMPTY}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="flex flex-wrap items-center gap-2 text-xs">
        <span>
          Apply {selected.size} {noun(selected.size, "suggestion", "suggestions")}
          {creates.length > 0
            ? `, creating ${creates.length} piece${creates.length === 1 ? "" : "s"} of equipment (${creates.join(", ")})`
            : ""}
          ?
        </span>
        <Button size="sm" variant="primary" disabled={busy || selected.size === 0} onClick={onConfirm}>
          Apply {selected.size}
        </Button>
        <Button size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </p>
    </div>
  );
}

// -------------------------------------------------------- name prefixes

/** One preview row as a person has edited it. */
export interface PrefixDraft {
  group: NamePrefixGroup;
  include: boolean;
  name: string;
  /** "" while a row that asks has no type chosen. */
  equipType: string;
}

export function initialPrefixDrafts(groups: readonly NamePrefixGroup[]): PrefixDraft[] {
  return groups.map((group) => ({
    group,
    include: groupIncludedByDefault(group),
    name: group.name,
    equipType: group.equipType ?? "",
  }));
}

/** The units the button counts: new pieces of equipment a type is proposed for. */
export function newEquipmentOffered(groups: readonly NamePrefixGroup[]): number {
  return groups.filter((g) => g.existing === null && groupIncludedByDefault(g)).length;
}

export interface PrefixRowState {
  /** The existing equipment the row will attach to, by its edited name. */
  existing: SettingsEquipment | null;
  /** Why the row cannot be confirmed as it stands, or null. */
  problem: string | null;
}

/**
 * What each ticked row will do and whether it can. Live, from the edited
 * names: a name that matches existing equipment (by equipmentKey) attaches
 * to it; two ticked rows that would be one piece of equipment, a blank name
 * or a new row with no type are problems, and Confirm stays off until none
 * is left. The server makes the same checks again.
 */
export function prefixRowStates(
  drafts: readonly PrefixDraft[],
  equipment: readonly SettingsEquipment[],
): PrefixRowState[] {
  const existingByKey = new Map<string, SettingsEquipment>();
  for (const e of equipment) {
    if (!existingByKey.has(equipmentKey(e.name))) existingByKey.set(equipmentKey(e.name), e);
  }
  const ticked = new Map<string, number>();
  for (const d of drafts) {
    if (!d.include || d.name.trim() === "") continue;
    const key = equipmentKey(d.name);
    ticked.set(key, (ticked.get(key) ?? 0) + 1);
  }
  return drafts.map((d) => {
    const name = d.name.trim();
    const existing = name === "" ? null : (existingByKey.get(equipmentKey(name)) ?? null);
    let problem: string | null = null;
    if (d.include) {
      if (name === "") problem = "Give it a name.";
      else if ((ticked.get(equipmentKey(name)) ?? 0) > 1) problem = "Another ticked row has the same name.";
      else if (existing === null && d.equipType === "") problem = "Choose a type.";
    }
    return { existing, problem };
  });
}

/** The request body for the ticked rows. */
export function prefixRequestRows(
  drafts: readonly PrefixDraft[],
  states: readonly PrefixRowState[],
): Array<{ key: string; name: string; equipType?: string }> {
  const rows: Array<{ key: string; name: string; equipType?: string }> = [];
  drafts.forEach((d, i) => {
    if (!d.include) return;
    const row: { key: string; name: string; equipType?: string } = { key: d.group.key, name: d.name.trim() };
    if (states[i]?.existing === null && d.equipType !== "") row.equipType = d.equipType;
    rows.push(row);
  });
  return rows;
}

export function PrefixPreview({
  drafts,
  onDraftsChange,
  equipment,
  equipmentTypes,
  onConfirm,
  onCancel,
  busy,
}: {
  drafts: readonly PrefixDraft[];
  onDraftsChange: (next: PrefixDraft[]) => void;
  equipment: readonly SettingsEquipment[];
  equipmentTypes: readonly EquipmentTypeOption[];
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const states = useMemo(() => prefixRowStates(drafts, equipment), [drafts, equipment]);
  const set = (index: number, patch: Partial<PrefixDraft>) =>
    onDraftsChange(drafts.map((d, i) => (i === index ? { ...d, ...patch } : d)));

  const ticked = drafts.filter((d) => d.include);
  const problems = states.filter((s) => s.problem !== null).length;
  const creating = drafts.filter((d, i) => d.include && states[i]?.existing === null).length;
  const attaching = drafts.filter((d, i) => d.include && states[i]?.existing !== null).length;
  const points = ticked.reduce((n, d) => n + d.group.pointIds.length, 0);
  const typeName = (key: string | null) =>
    key === null ? null : (equipmentTypes.find((t) => t.equipType === key)?.displayName ?? key);

  return (
    <div
      className="space-y-2 rounded-[var(--radius-control)] border p-3"
      style={TONE_STYLE.warn}
      role="dialog"
      aria-label="Review the equipment from name prefixes"
    >
      <p className="text-xs">
        Each row is a unit the point names start with, and the points that would be attached to it.
        Only collected points with no equipment are listed; a point that already has equipment is
        never moved. Edit a name or a type before confirming. Rows the names do not explain -
        an I/O module, an unknown prefix - start unticked.
      </p>
      <div className="max-h-96 overflow-auto rounded-[var(--radius-row)] bg-[var(--surface)]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left text-[var(--muted)]">
            <tr>
              <th className="eyebrow py-2 pl-2 pr-3 text-[var(--muted)]">
                <span className="sr-only">Include</span>
              </th>
              <th className="eyebrow py-2 pr-3 text-[var(--muted)]">Prefix</th>
              <th className="eyebrow py-2 pr-3 text-[var(--muted)]">Equipment name</th>
              <th className="eyebrow py-2 pr-3 text-[var(--muted)]">Type</th>
              <th className="eyebrow py-2 pr-3 text-[var(--muted)]">Points</th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((draft, index) => {
              const state = states[index]!;
              const group = draft.group;
              return (
                <tr key={group.key} className="border-t border-[var(--divider-soft)] align-top">
                  <td className="py-2 pl-2 pr-3">
                    <input
                      type="checkbox"
                      checked={draft.include}
                      disabled={busy}
                      aria-label={`Include ${draft.name || group.name}`}
                      onChange={() => set(index, { include: !draft.include })}
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <span className="font-mono">{group.spellings.join(" · ")}</span>
                    {group.spellings.length > 1 && (
                      <span className="block text-[var(--muted)]">
                        {group.spellings.length} spellings of one unit
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <input
                      className={INPUT}
                      value={draft.name}
                      disabled={busy}
                      maxLength={120}
                      aria-label={`Equipment name for ${group.spellings[0] ?? group.name}`}
                      onChange={(e) => set(index, { name: e.target.value })}
                    />
                    {state.existing !== null && (
                      <span className="mt-1 block text-[var(--muted)]">
                        Already exists: the points attach to {state.existing.name}.
                      </span>
                    )}
                    {state.problem !== null && (
                      <span className="mt-1 block text-[var(--phb-maroon)]" role="alert">
                        {state.problem}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {state.existing !== null ? (
                      <span>{typeName(state.existing.equipType) ?? EMPTY}</span>
                    ) : (
                      <select
                        className={INPUT}
                        value={draft.equipType}
                        disabled={busy}
                        aria-label={`Equipment type for ${draft.name || group.name}`}
                        onChange={(e) => set(index, { equipType: e.target.value })}
                      >
                        <option value="">Choose a type…</option>
                        {equipmentTypes.map((t) => (
                          <option key={t.equipType} value={t.equipType}>
                            {t.displayName}
                          </option>
                        ))}
                      </select>
                    )}
                    <span className="mt-1 block max-w-72 text-[var(--muted)]">{group.typeReason}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <span className="tabular-nums">{group.pointIds.length}</span>
                    <span className="block text-[var(--muted)]" title={group.sampleNames.join("\n")}>
                      {group.sampleNames.join(", ")}
                      {group.pointIds.length > group.sampleNames.length ? ", …" : ""}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="flex flex-wrap items-center gap-2 text-xs">
        <span>
          Create {creating} piece{creating === 1 ? "" : "s"} of equipment
          {attaching > 0 ? `, use ${attaching} that already exist,` : ""} and attach {points}{" "}
          {noun(points, "point", "points")}?
          {problems > 0 ? ` Fix ${problems} ${noun(problems, "row", "rows")} first.` : ""}
        </span>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || ticked.length === 0 || problems > 0}
          onClick={onConfirm}
        >
          Confirm
        </Button>
        <Button size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </p>
    </div>
  );
}

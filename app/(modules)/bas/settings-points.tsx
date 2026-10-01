"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  groupRoles,
  pointDisplayName,
  pointMatchesSearch,
  pointsCountState,
} from "@/lib/modules/bas/types";
import type {
  BasVocabularies,
  BuildingEquipmentList,
  PointSuggestion,
  SettingsEquipment,
  SettingsPoint,
  StationPointsList,
} from "@/lib/modules/bas/types";
import {
  ApiError,
  ROLE_RIPPLE_NOTE,
  bulkClassifyPoints,
  createEquipment,
  deleteEquipment,
  describeBulkResult,
  describeCollected,
  describePointCompleteness,
  describeSuggestion,
  fetchBuildingEquipment,
  fetchStationPoints,
  fetchVocabularies,
  updateEquipment,
  updatePointEquipment,
  updatePointLabel,
  updatePointRole,
  updatePointVisibility,
} from "./health-client";
import { planSuggestionBatches } from "@/lib/modules/bas/suggestions";
import { TONE_INK, TONE_STYLE } from "./tone";
import { HorizonCell } from "./collection-health";

/**
 * The Points level of the Settings tree: one station's points, and
 * everything a person can do to them (B8.2 to B8.5).
 *
 * B8.2 listed them. B8.3 made *Shown* a checkbox and B8.4 the label a cell.
 * B8.5 adds the two pickers - role and equipment - the inline equipment form
 * with its parent and notes, a selection with bulk assign, and suggestions.
 *
 * THE RULE THAT THIS FILE IS BUILT AROUND: nothing is written until a person
 * clicks. A suggestion is a sentence on the row and a button; the service
 * that computed it never wrote it, and the click is what sends the request.
 * "Apply all N suggestions" is still one click by one person, on a count
 * they were shown first.
 *
 * Every classification write refetches the list rather than patching local
 * state, as the settings tree does: the suggestions are computed
 * server-side from what the row now holds, and a row patched by hand would
 * keep offering a suggestion the database has already accepted.
 */

const FIELD =
  "rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-xs";
const BUTTON =
  "rounded border border-[var(--border)] px-1.5 py-0.5 text-xs disabled:opacity-50";
const EMPTY = <span className="text-[var(--muted)]">—</span>;

// ---------------------------------------------------------------- filters

/**
 * The list's filters (B8.5). Pure data, so `pointMatchesFilters` can be
 * tested without a DOM and the "select all shown" button can be proved to
 * select exactly the filtered rows. `"any"` is no filter; `"none"` is the
 * NULL value (no role, no equipment); anything else is a value to equal.
 */
export interface PointFilters {
  role: "any" | "none" | string;
  equipment: "any" | "none" | string;
  collected: "any" | "yes" | "no";
}

export const NO_POINT_FILTERS: PointFilters = {
  role: "any",
  equipment: "any",
  collected: "any",
};

export function pointMatchesFilters(point: SettingsPoint, filters: PointFilters): boolean {
  if (filters.role === "none" && point.pointRole !== null) return false;
  if (filters.role !== "any" && filters.role !== "none" && point.pointRole !== filters.role) {
    return false;
  }
  if (filters.equipment === "none" && point.equipmentId !== null) return false;
  if (
    filters.equipment !== "any" &&
    filters.equipment !== "none" &&
    point.equipmentId !== filters.equipment
  ) {
    return false;
  }
  if (filters.collected === "yes" && !point.collected) return false;
  if (filters.collected === "no" && point.collected) return false;
  return true;
}

/** The rows the search AND the filters leave: what "select all shown" selects. */
export function shownPoints(
  points: readonly SettingsPoint[],
  query: string,
  filters: PointFilters,
): SettingsPoint[] {
  return points.filter(
    (point) => pointMatchesSearch(point, query) && pointMatchesFilters(point, filters),
  );
}

// ------------------------------------------------------------ the station

/** What the bulk form holds before Apply. "" is "leave it alone". */
interface BulkDraft {
  role: "" | "__clear__" | string;
  equipment: "" | "__clear__" | "__new__" | string;
}

const EMPTY_BULK: BulkDraft = { role: "", equipment: "" };

/** A write about to happen, shown for confirmation with its count. */
interface PendingBulk {
  pointIds: string[];
  role?: string | null;
  equipmentId?: string | null;
  sentence: string;
}

interface EquipmentFormState {
  mode: "create" | "edit";
  equipment: SettingsEquipment | null;
  /** Points to attach once created (the bulk form's "New equipment…"). */
  attachTo: string[];
}

export function StationPoints({
  stationId,
  expectedTotal,
  initialQuery,
}: {
  stationId: string;
  expectedTotal: number;
  /**
   * The tree's search term, if any (B8.4). A station that surfaced because
   * one of its points matched would otherwise show all of them and leave the
   * person to find the match by eye.
   */
  initialQuery: string;
}) {
  const [list, setList] = useState<StationPointsList | null>(null);
  const [vocabularies, setVocabularies] = useState<BasVocabularies | null>(null);
  const [equipment, setEquipment] = useState<BuildingEquipmentList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [filters, setFilters] = useState<PointFilters>(NO_POINT_FILTERS);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<BulkDraft>(EMPTY_BULK);
  const [pending, setPending] = useState<PendingBulk | null>(null);
  const [pendingSuggestions, setPendingSuggestions] = useState<number | null>(null);
  const [equipmentForm, setEquipmentForm] = useState<EquipmentFormState | null>(null);
  const [showEquipment, setShowEquipment] = useState(false);
  const [busy, setBusy] = useState(false);

  const failed = (cause: unknown) =>
    setSaveError(cause instanceof ApiError ? cause.message : "Something went wrong.");

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const loaded = await fetchStationPoints(stationId, signal);
      setList(loaded);
      // Drop any selected id the list no longer has.
      setSelected((current) => {
        const ids = new Set(loaded.points.map((p) => p.pointId));
        return new Set([...current].filter((id) => ids.has(id)));
      });
      return loaded;
    },
    [stationId],
  );

  const loadEquipment = useCallback(
    async (siteId: string | null, signal?: AbortSignal) => {
      if (siteId === null) {
        setEquipment(null);
        return;
      }
      setEquipment(await fetchBuildingEquipment(siteId, signal));
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const loaded = await reload(controller.signal);
        await Promise.all([
          loadEquipment(loaded.siteId, controller.signal),
          fetchVocabularies().then(setVocabularies),
        ]);
      } catch (cause: unknown) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError("unexpected", "Something went wrong."),
        );
      }
    })();
    return () => controller.abort();
  }, [reload, loadEquipment]);

  /** Run a write, then refetch what it could have changed. */
  const run = useCallback(
    async (action: () => Promise<string | null>, refetchEquipment = false) => {
      setBusy(true);
      setSaveError(null);
      setNotice(null);
      try {
        const summary = await action();
        const loaded = await reload();
        if (refetchEquipment) await loadEquipment(loaded.siteId);
        if (summary !== null) setNotice(summary);
        return true;
      } catch (cause: unknown) {
        failed(cause);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [reload, loadEquipment],
  );

  /**
   * The label (B8.4). NOT optimistic: the server trims and normalises what
   * was typed, and the row should show what the database holds.
   */
  const saveLabel = useCallback(
    async (point: SettingsPoint, label: string | null): Promise<void> => {
      setSaveError(null);
      try {
        const saved = await updatePointLabel(point.pointId, label);
        setList((current) =>
          current === null
            ? current
            : {
                ...current,
                points: current.points.map((row) =>
                  row.pointId === point.pointId ? { ...row, label: saved.label } : row,
                ),
              },
        );
      } catch (cause: unknown) {
        failed(cause);
        throw cause;
      }
    },
    [],
  );

  /**
   * The Shown checkbox (B8.3). Optimistic: flip the row, call the API, flip
   * it back if that fails. Hiding is cosmetic and reversible.
   */
  const toggleVisible = useCallback((point: SettingsPoint, visible: boolean) => {
    const flip = (to: boolean) =>
      setList((current) =>
        current === null
          ? current
          : {
              ...current,
              points: current.points.map((row) =>
                row.pointId === point.pointId ? { ...row, visible: to } : row,
              ),
            },
      );
    setSaveError(null);
    flip(visible);
    void updatePointVisibility(point.pointId, visible).catch((cause: unknown) => {
      flip(!visible);
      failed(cause);
    });
  }, []);

  const setRole = useCallback(
    (point: SettingsPoint, role: string | null) =>
      run(async () => {
        await updatePointRole(point.pointId, role);
        return null;
      }).then(() => undefined),
    [run],
  );

  const setPointEquipment = useCallback(
    (point: SettingsPoint, equipmentId: string | null) =>
      run(async () => {
        await updatePointEquipment(point.pointId, equipmentId);
        return null;
      }).then(() => undefined),
    [run],
  );

  /**
   * Accept one suggestion: create the equipment if the suggestion says it is
   * new, then one bulk request on a selection of one carrying both halves.
   * Two audit rows at most, both the person's.
   */
  const applySuggestion = useCallback(
    (point: SettingsPoint) => {
      const suggestion = point.suggestion;
      if (suggestion === null || list === null) return Promise.resolve();
      return run(async () => {
        const equipmentId = await ensureSuggestedEquipment(list.siteId, suggestion);
        const body: { pointIds: string[]; role?: string | null; equipmentId?: string | null } = {
          pointIds: [point.pointId],
        };
        if (suggestion.role !== null) body.role = suggestion.role;
        if (equipmentId !== null) body.equipmentId = equipmentId;
        const result = await bulkClassifyPoints(body);
        return describeBulkResult(result);
      }, true).then(() => undefined);
    },
    [list, run],
  );

  /**
   * Accept every suggestion on the list, after a confirmation naming the
   * count. Each missing piece of equipment is created once; then one bulk
   * request per distinct (role, equipment) pair.
   */
  const applyAllSuggestions = useCallback(() => {
    if (list === null) return;
    setPendingSuggestions(null);
    void run(async () => {
      // The plan is pure data (planSuggestionBatches) and the acceptance test
      // executes the same plan through the same routes, so what this does is
      // exactly what the test holds the UI to.
      const plan = planSuggestionBatches(list.points);
      const created = new Map<string, string>();
      if (list.siteId !== null) {
        for (const item of plan.create) {
          const { equipmentId } = await createEquipment({
            siteId: list.siteId,
            name: item.name,
            equipType: item.equipType,
          });
          created.set(item.name.toLowerCase(), equipmentId);
        }
      }
      let points = 0;
      let roleChanged = 0;
      let equipmentChanged = 0;
      let unchanged = 0;
      for (const batch of plan.batches) {
        const equipmentId =
          batch.equipmentId ??
          (batch.equipmentName === null
            ? null
            : (created.get(batch.equipmentName.toLowerCase()) ?? null));
        const body: { pointIds: string[]; role?: string | null; equipmentId?: string | null } = {
          pointIds: batch.pointIds,
        };
        if (batch.role !== null) body.role = batch.role;
        if (equipmentId !== null) body.equipmentId = equipmentId;
        if (body.role === undefined && body.equipmentId === undefined) continue;
        const result = await bulkClassifyPoints(body);
        points += result.points;
        roleChanged += result.roleChanged;
        equipmentChanged += result.equipmentChanged;
        unchanged += result.unchanged;
      }
      return describeBulkResult({ points, roleChanged, equipmentChanged, unchanged });
    }, true);
  }, [list, run]);

  /** Stage the bulk form as a sentence with its count, for confirmation. */
  const stageBulk = useCallback(() => {
    if (list === null || selected.size === 0) return;
    if (bulk.role === "" && bulk.equipment === "") return;
    if (bulk.equipment === "__new__") {
      setEquipmentForm({ mode: "create", equipment: null, attachTo: [...selected] });
      return;
    }
    const roleName =
      bulk.role === "" || bulk.role === "__clear__"
        ? null
        : (vocabularies?.roles.find((r) => r.pointRole === bulk.role)?.displayName ?? bulk.role);
    const equipmentName =
      bulk.equipment === "" || bulk.equipment === "__clear__"
        ? null
        : (equipment?.equipment.find((e) => e.equipmentId === bulk.equipment)?.name ??
          bulk.equipment);
    const plan: PendingBulk = {
      pointIds: [...selected],
      sentence: describeBulkPlan(
        bulk.role === "" ? undefined : bulk.role === "__clear__" ? null : roleName,
        bulk.equipment === "" ? undefined : bulk.equipment === "__clear__" ? null : equipmentName,
        selected.size,
      ),
    };
    if (bulk.role !== "") plan.role = bulk.role === "__clear__" ? null : bulk.role;
    if (bulk.equipment !== "") plan.equipmentId = bulk.equipment === "__clear__" ? null : bulk.equipment;
    setPending(plan);
  }, [list, selected, bulk, vocabularies, equipment]);

  const confirmBulk = useCallback(() => {
    if (pending === null) return;
    const plan = pending;
    setPending(null);
    void run(async () => {
      const body: { pointIds: string[]; role?: string | null; equipmentId?: string | null } = {
        pointIds: plan.pointIds,
      };
      if (plan.role !== undefined) body.role = plan.role;
      if (plan.equipmentId !== undefined) body.equipmentId = plan.equipmentId;
      const result = await bulkClassifyPoints(body);
      setSelected(new Set());
      setBulk(EMPTY_BULK);
      return describeBulkResult(result);
    });
  }, [pending, run]);

  const submitEquipment = useCallback(
    (values: EquipmentValues) => {
      if (equipmentForm === null || list === null) return Promise.resolve(false);
      const form = equipmentForm;
      return run(async () => {
        if (form.mode === "edit" && form.equipment !== null) {
          await updateEquipment(form.equipment.equipmentId, {
            name: values.name,
            equipType: values.equipType,
            parentEquipmentId: values.parentEquipmentId === "" ? null : values.parentEquipmentId,
            notes: values.notes === "" ? null : values.notes,
          });
          setEquipmentForm(null);
          return null;
        }
        if (list.siteId === null) throw new ApiError("station_unassigned", "This station is attached to no building.");
        const { equipmentId } = await createEquipment({
          siteId: list.siteId,
          name: values.name,
          equipType: values.equipType,
          parentEquipmentId: values.parentEquipmentId === "" ? null : values.parentEquipmentId,
          notes: values.notes === "" ? null : values.notes,
        });
        setEquipmentForm(null);
        if (form.attachTo.length > 0) {
          const result = await bulkClassifyPoints({ pointIds: form.attachTo, equipmentId });
          setSelected(new Set());
          setBulk(EMPTY_BULK);
          return `Added ${values.name}. ${describeBulkResult(result)}`;
        }
        return `Added ${values.name}.`;
      }, true);
    },
    [equipmentForm, list, run],
  );

  const removeEquipment = useCallback(
    (item: SettingsEquipment) =>
      run(async () => {
        await deleteEquipment(item.equipmentId);
        return `Deleted ${item.name}.`;
      }, true),
    [run],
  );

  if (error !== null) {
    return (
      <p className="mt-3 rounded-md border p-3 text-xs" style={TONE_STYLE.bad} role="alert">
        {error.message}
      </p>
    );
  }
  if (list === null) {
    return <p className="mt-3 text-xs text-[var(--muted)]">Loading points…</p>;
  }

  const shown = shownPoints(list.points, query, filters);
  const suggestionCount = list.points.filter((p) => p.suggestion !== null).length;
  const canClassify = vocabularies !== null;

  return (
    <>
      {saveError !== null && (
        <p className="mt-3 rounded-md border p-3 text-xs" style={TONE_STYLE.bad} role="alert">
          Could not save that change: {saveError} The list shows what the database
          still holds.
        </p>
      )}
      {notice !== null && (
        <p className="mt-3 rounded-md border p-3 text-xs" style={TONE_STYLE.ok} role="status">
          {notice}
        </p>
      )}

      {list.points.length > 0 && canClassify && (
        <ClassificationToolbar
          list={list}
          shown={shown}
          filters={filters}
          onFiltersChange={(next) => setFilters(next)}
          vocabularies={vocabularies}
          equipment={equipment}
          selected={selected}
          onSelectionChange={setSelected}
          bulk={bulk}
          onBulkChange={setBulk}
          onStageBulk={stageBulk}
          pending={pending}
          onConfirmBulk={confirmBulk}
          onCancelBulk={() => setPending(null)}
          suggestionCount={suggestionCount}
          pendingSuggestions={pendingSuggestions}
          onStageSuggestions={() => setPendingSuggestions(suggestionCount)}
          onConfirmSuggestions={applyAllSuggestions}
          onCancelSuggestions={() => setPendingSuggestions(null)}
          busy={busy}
        />
      )}

      {equipmentForm !== null && vocabularies !== null && (
        <EquipmentForm
          state={equipmentForm}
          vocabularies={vocabularies}
          equipment={equipment?.equipment ?? []}
          busy={busy}
          onSubmit={submitEquipment}
          onCancel={() => setEquipmentForm(null)}
        />
      )}

      <PointsTable
        list={list}
        expectedTotal={expectedTotal}
        query={query}
        onQueryChange={setQuery}
        rowFilter={(point) => pointMatchesFilters(point, filters)}
        vocabularies={vocabularies}
        equipment={equipment?.equipment ?? (list.siteId === null ? null : [])}
        selected={canClassify ? selected : undefined}
        onSelectionChange={canClassify ? setSelected : undefined}
        onToggleVisible={toggleVisible}
        onSaveLabel={saveLabel}
        onSetRole={canClassify ? setRole : undefined}
        onSetEquipment={canClassify ? setPointEquipment : undefined}
        onNewEquipment={
          canClassify && list.siteId !== null
            ? (point) =>
                setEquipmentForm({ mode: "create", equipment: null, attachTo: [point.pointId] })
            : undefined
        }
        onApplySuggestion={canClassify ? applySuggestion : undefined}
        busy={busy}
      />

      {list.siteId !== null && canClassify && (
        <EquipmentPanel
          equipment={equipment}
          open={showEquipment}
          onToggle={() => setShowEquipment((open) => !open)}
          onNew={() => setEquipmentForm({ mode: "create", equipment: null, attachTo: [] })}
          onEdit={(item) => setEquipmentForm({ mode: "edit", equipment: item, attachTo: [] })}
          onDelete={(item) => void removeEquipment(item)}
          busy={busy}
        />
      )}
    </>
  );
}

/**
 * The equipment a suggestion names, created if it does not exist yet. Null
 * when the suggestion names no equipment or the station has no building to
 * create it on - in which case only the role half is applied.
 */
async function ensureSuggestedEquipment(
  siteId: string | null,
  suggestion: PointSuggestion,
): Promise<string | null> {
  if (suggestion.equipmentName === null) return null;
  if (suggestion.equipmentId !== null) return suggestion.equipmentId;
  if (siteId === null || suggestion.equipType === null) return null;
  const { equipmentId } = await createEquipment({
    siteId,
    name: suggestion.equipmentName,
    equipType: suggestion.equipType,
  });
  return equipmentId;
}

/**
 * "Set the role to Zone Temperature and attach to VAV-3 on 10 points."
 * `undefined` leaves a half out of the sentence; `null` says "clear".
 * Exported for the test that holds the confirmation to the count.
 */
export function describeBulkPlan(
  roleName: string | null | undefined,
  equipmentName: string | null | undefined,
  count: number,
): string {
  const parts: string[] = [];
  if (roleName === null) parts.push("clear the role");
  else if (roleName !== undefined) parts.push(`set the role to ${roleName}`);
  if (equipmentName === null) parts.push("detach from equipment");
  else if (equipmentName !== undefined) parts.push(`attach to ${equipmentName}`);
  const verb = parts.join(" and ");
  const sentence = `${verb} on ${count} ${count === 1 ? "point" : "points"}`;
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

// ---------------------------------------------------------------- toolbar

function ClassificationToolbar({
  list,
  shown,
  filters,
  onFiltersChange,
  vocabularies,
  equipment,
  selected,
  onSelectionChange,
  bulk,
  onBulkChange,
  onStageBulk,
  pending,
  onConfirmBulk,
  onCancelBulk,
  suggestionCount,
  pendingSuggestions,
  onStageSuggestions,
  onConfirmSuggestions,
  onCancelSuggestions,
  busy,
}: {
  list: StationPointsList;
  shown: SettingsPoint[];
  filters: PointFilters;
  onFiltersChange: (next: PointFilters) => void;
  vocabularies: BasVocabularies;
  equipment: BuildingEquipmentList | null;
  selected: ReadonlySet<string>;
  onSelectionChange: (next: ReadonlySet<string>) => void;
  bulk: BulkDraft;
  onBulkChange: (next: BulkDraft) => void;
  onStageBulk: () => void;
  pending: PendingBulk | null;
  onConfirmBulk: () => void;
  onCancelBulk: () => void;
  suggestionCount: number;
  pendingSuggestions: number | null;
  onStageSuggestions: () => void;
  onConfirmSuggestions: () => void;
  onCancelSuggestions: () => void;
  busy: boolean;
}) {
  // Filter options come from what the list holds, so a filter can never
  // name a role no point on this station carries.
  const rolesInUse = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of list.points) {
      if (p.pointRole !== null) seen.set(p.pointRole, p.roleName ?? p.pointRole);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [list.points]);
  const equipmentInUse = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of list.points) {
      if (p.equipmentId !== null) seen.set(p.equipmentId, p.equipmentName ?? p.equipmentId);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [list.points]);
  const groups = useMemo(() => groupRoles(vocabularies.roles), [vocabularies.roles]);
  const hasBuilding = list.siteId !== null;
  const noun = (n: number) => (n === 1 ? "point" : "points");

  return (
    <div className="mt-3 space-y-2 rounded border border-[var(--border)] p-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[var(--muted)]">Filter</span>
        <select
          className={FIELD}
          aria-label="Filter by role"
          value={filters.role}
          onChange={(e) => onFiltersChange({ ...filters, role: e.target.value })}
        >
          <option value="any">Any role</option>
          <option value="none">No role</option>
          {rolesInUse.map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
        <select
          className={FIELD}
          aria-label="Filter by equipment"
          value={filters.equipment}
          onChange={(e) => onFiltersChange({ ...filters, equipment: e.target.value })}
        >
          <option value="any">Any equipment</option>
          <option value="none">No equipment</option>
          {equipmentInUse.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select
          className={FIELD}
          aria-label="Filter by collected"
          value={filters.collected}
          onChange={(e) =>
            onFiltersChange({ ...filters, collected: e.target.value as PointFilters["collected"] })
          }
        >
          <option value="any">Collected or not</option>
          <option value="yes">Collected</option>
          <option value="no">Not collected</option>
        </select>
        <span className="text-[var(--muted)]">·</span>
        <button
          type="button"
          className={BUTTON}
          disabled={busy || shown.length === 0}
          onClick={() => onSelectionChange(new Set(shown.map((p) => p.pointId)))}
        >
          Select all {shown.length} shown
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy || selected.size === 0}
          onClick={() => onSelectionChange(new Set())}
        >
          Select none
        </button>
        <span aria-live="polite">
          {selected.size} selected
        </span>
      </div>

      {/*
        The bulk form. Disabled, not hidden, with nothing selected: a control
        that appears and disappears teaches people to hunt for it.
      */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[var(--muted)]">On the selection, set</span>
        <select
          className={FIELD}
          aria-label="Role to set on the selected points"
          value={bulk.role}
          disabled={busy || selected.size === 0}
          onChange={(e) => onBulkChange({ ...bulk, role: e.target.value })}
        >
          <option value="">Role: leave as is</option>
          <option value="__clear__">Clear the role</option>
          {groups.map((group) => (
            <optgroup key={group.key} label={group.label}>
              {group.roles.map((role) => (
                <option key={role.pointRole} value={role.pointRole}>
                  {role.displayName}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <select
          className={FIELD}
          aria-label="Equipment to set on the selected points"
          value={bulk.equipment}
          disabled={busy || selected.size === 0 || !hasBuilding}
          title={hasBuilding ? undefined : "This station is attached to no building, so it has no equipment."}
          onChange={(e) => onBulkChange({ ...bulk, equipment: e.target.value })}
        >
          <option value="">Equipment: leave as is</option>
          <option value="__clear__">Detach from equipment</option>
          {(equipment?.equipment ?? []).map((item) => (
            <option key={item.equipmentId} value={item.equipmentId}>
              {item.name}
              {item.equipTypeName !== null ? ` (${item.equipTypeName})` : ""}
            </option>
          ))}
          <option value="__new__">New equipment…</option>
        </select>
        <button
          type="button"
          className={BUTTON}
          disabled={busy || selected.size === 0 || (bulk.role === "" && bulk.equipment === "")}
          onClick={onStageBulk}
        >
          Apply to {selected.size} {noun(selected.size)}
        </button>
      </div>

      {pending !== null && (
        <p className="flex flex-wrap items-center gap-2 rounded border p-2 text-xs" style={TONE_STYLE.warn} role="alertdialog">
          <span>{pending.sentence}</span>
          <button type="button" className={BUTTON} disabled={busy} onClick={onConfirmBulk}>
            Confirm
          </button>
          <button type="button" className={BUTTON} disabled={busy} onClick={onCancelBulk}>
            Cancel
          </button>
        </p>
      )}

      {/*
        Suggestions. The count and a button - never applied on their own.
        The button is disabled, not hidden, at zero, so the absence of
        suggestions on a station reads as "none" rather than as a feature
        that is not there.
      */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[var(--muted)]">
          {suggestionCount} {suggestionCount === 1 ? "suggestion" : "suggestions"} from name
          patterns, applied only when clicked.
        </span>
        <button
          type="button"
          className={BUTTON}
          disabled={busy || suggestionCount === 0}
          onClick={onStageSuggestions}
        >
          Apply all {suggestionCount}
        </button>
        {pendingSuggestions !== null && (
          <span className="flex flex-wrap items-center gap-2 rounded border p-1" style={TONE_STYLE.warn} role="alertdialog">
            <span>
              Apply {pendingSuggestions} {pendingSuggestions === 1 ? "suggestion" : "suggestions"}
              , creating any equipment they name?
            </span>
            <button type="button" className={BUTTON} disabled={busy} onClick={onConfirmSuggestions}>
              Confirm
            </button>
            <button type="button" className={BUTTON} disabled={busy} onClick={onCancelSuggestions}>
              Cancel
            </button>
          </span>
        )}
      </div>

      <p className="text-xs text-[var(--muted)]">{ROLE_RIPPLE_NOTE}</p>
    </div>
  );
}

// ------------------------------------------------------------- the table

/**
 * The list itself. Pure - no fetch, no hooks of its own - so tests can render
 * it with a payload whose counts disagree and read the alarm off the HTML.
 * Exported for that reason, re-exported from settings-view.tsx.
 *
 * EVERYTHING the service returned is drawn. Nothing here filters on
 * `collected` or on `visible`: an uncollected point is the row somebody most
 * needs to see, and a HIDDEN point must stay on this list too - this is
 * where it gets shown again (B8.3).
 *
 * What narrows the rows is the search box (B8.4) and the filters (B8.5),
 * and they narrow what is DRAWN, not what was fetched: the counts above the
 * table are still the service's, the alarm still compares the service's two
 * numbers, and the narrowing reports its own "N of M match" beside them.
 *
 * The pickers and the selection render only when their handlers are passed,
 * so a static render (and the B8.2-B8.4 tests) sees the list as it was.
 */
export function PointsTable({
  list,
  expectedTotal,
  query = "",
  onQueryChange,
  rowFilter,
  vocabularies = null,
  equipment = null,
  selected,
  onSelectionChange,
  onToggleVisible,
  onSaveLabel,
  onSetRole,
  onSetEquipment,
  onNewEquipment,
  onApplySuggestion,
  busy = false,
}: {
  list: StationPointsList;
  /** The tree's own count for the row above, so a stale tree is named as such. */
  expectedTotal: number;
  /** The search term. Blank draws every row. */
  query?: string;
  /** Absent in a static render; the search box is then read-only. */
  onQueryChange?: (query: string) => void;
  /** The filters (B8.5), as a predicate. Absent draws every row the search leaves. */
  rowFilter?: (point: SettingsPoint) => boolean;
  /** The vocabulary for the role picker. Null renders the role as text. */
  vocabularies?: BasVocabularies | null;
  /** The building's equipment for the picker. Null means the station has no building. */
  equipment?: SettingsEquipment[] | null;
  /** The selection (B8.5). Absent hides the checkbox column. */
  selected?: ReadonlySet<string>;
  onSelectionChange?: (next: ReadonlySet<string>) => void;
  /** Absent in a static render; the checkbox is then read-only. */
  onToggleVisible?: (point: SettingsPoint, visible: boolean) => void;
  /** Absent in a static render; the label is then plain text. */
  onSaveLabel?: (point: SettingsPoint, label: string | null) => Promise<void>;
  onSetRole?: (point: SettingsPoint, role: string | null) => Promise<void>;
  onSetEquipment?: (point: SettingsPoint, equipmentId: string | null) => Promise<void>;
  onNewEquipment?: (point: SettingsPoint) => void;
  onApplySuggestion?: (point: SettingsPoint) => Promise<void>;
  busy?: boolean;
}) {
  const { rendered, inDatabase } = list.pointsAccountedFor;
  const { alarm } = pointsCountState(list.pointsAccountedFor);
  const missing = inDatabase - rendered;
  const noun = (n: number) => (n === 1 ? "point" : "points");
  const searching = query.trim().length > 0;
  const shown = list.points.filter(
    (point) => pointMatchesSearch(point, query) && (rowFilter === undefined || rowFilter(point)),
  );
  const narrowed = shown.length !== list.points.length;
  const selectable = selected !== undefined && onSelectionChange !== undefined;
  const columns = 10 + (selectable ? 1 : 0);

  return (
    <div className="mt-3 space-y-2">
      {/*
        The accounting check, said out loud only when it fails. `inDatabase` is
        counted by a query with no joins; `rendered` is what the joined list
        query returned.
      */}
      {alarm && (
        <p className="rounded-md border p-3 text-xs" style={TONE_STYLE.bad} role="alert">
          This list shows {rendered} of the {inDatabase} {noun(inDatabase)} the
          database holds for this station, so {missing} could not be placed and{" "}
          {missing === 1 ? "is" : "are"} not on this screen. Report this - a
          point missing from Settings may still be collecting, or may have
          stopped.
        </p>
      )}

      {!alarm && inDatabase !== expectedTotal && (
        <p className="text-xs text-[var(--muted)]">
          The tree counted {expectedTotal} {noun(expectedTotal)} for this
          station when it loaded; the database now holds {inDatabase}. Reload
          to refresh the station row.
        </p>
      )}

      <p className="text-xs text-[var(--muted)]">
        {inDatabase} {noun(inDatabase)} in the database for this station,{" "}
        {rendered} listed.
      </p>

      {list.points.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">
          No points registered. Run discover against this station to register
          its histories.
        </p>
      ) : (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <input
              className="w-full max-w-md rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
              type="search"
              value={query}
              readOnly={onQueryChange === undefined}
              placeholder="Search by label, station name, or Niagara name (e.g. VAV$2d8)"
              aria-label="Search this station's points by any of their names"
              onChange={(event) => onQueryChange?.(event.target.value)}
            />
            {narrowed && (
              <span className="text-xs text-[var(--muted)]">
                {shown.length} of {list.points.length} {noun(list.points.length)} match
              </span>
            )}
          </div>
          <div className="max-h-72 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left">
                <tr className="text-left text-[var(--muted)]">
                  {selectable && (
                    <th className="py-1 pr-2 font-medium">
                      <span className="sr-only">Select</span>
                    </th>
                  )}
                  <th
                    className="py-1 pr-3 font-medium"
                    title="What a person calls this point. Shown in Point Explorer and Collection Health in place of the station's name, and nowhere else. Blank means the station's name is used. A label replaces the station's name on those screens; it never changes what the collector asks the station for."
                  >
                    Label
                  </th>
                  <th
                    className="py-1 pr-3 font-medium"
                    title="The oBIX history key, exactly as the station spells it. This is what the collector asks the station for, so the Niagara name is never editable."
                  >
                    Niagara name
                  </th>
                  <th
                    className="py-1 pr-3 font-medium"
                    title="What the station reports for this history. Not the person's label - that is the Label column."
                  >
                    Station name
                  </th>
                  <th
                    className="py-1 pr-3 font-medium"
                    title="What the point measures or commands, from the vocabulary. Not cosmetic: the setpoint and command/status pairings, the unclassified count and the Analyze catalogue all judge a point by its role, so a wrong role is judged by the wrong rule. Blank means nobody has looked."
                  >
                    Role
                  </th>
                  <th
                    className="py-1 pr-3 font-medium"
                    title="The equipment this point belongs to. A point pairs with its setpoint only through shared equipment, so a point with none is outside every cross-equipment comparison."
                  >
                    Equipment
                  </th>
                  <th
                    className="py-1 pr-3 font-medium"
                    title="What a name pattern would classify this point as. Never applied on its own: nothing is written until the button is clicked. A point with no confident pattern shows none."
                  >
                    Suggestion
                  </th>
                  <th className="py-1 pr-3 font-medium">Collected</th>
                  <th className="py-1 pr-3 font-medium">Completeness</th>
                  <th
                    className="py-1 pr-3 font-medium"
                    title="How long the station keeps this history before overwriting it. Measured from the shortest span its full buffer has been seen to hold, or configured from capacity x interval. A buffer that has never filled has overwritten nothing and reads Not full yet."
                  >
                    Roll horizon
                  </th>
                  <th
                    className="py-1 font-medium"
                    title="Whether the point appears in Point Explorer and the Collection Health table. Unticking hides it from those two screens only: it is still collected and still counts in every risk figure."
                  >
                    Shown
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((point) => (
                  <PointRow
                    key={point.pointId}
                    point={point}
                    vocabularies={vocabularies}
                    equipment={equipment}
                    selected={selectable ? selected.has(point.pointId) : null}
                    onSelect={
                      selectable
                        ? (checked) => {
                            const next = new Set(selected);
                            if (checked) next.add(point.pointId);
                            else next.delete(point.pointId);
                            onSelectionChange(next);
                          }
                        : undefined
                    }
                    onToggleVisible={onToggleVisible}
                    onSaveLabel={onSaveLabel}
                    onSetRole={onSetRole}
                    onSetEquipment={onSetEquipment}
                    onNewEquipment={onNewEquipment}
                    onApplySuggestion={onApplySuggestion}
                    busy={busy}
                  />
                ))}
                {narrowed && shown.length === 0 && (
                  <tr className="border-t border-[var(--border)]">
                    <td className="py-2 text-[var(--muted)]" colSpan={columns}>
                      {searching
                        ? `No point on this station matches "${query.trim()}" by label, station name or Niagara name`
                        : "No point on this station matches the filters"}
                      . Clear {searching ? "the search" : "them"} to see all{" "}
                      {list.points.length}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function PointRow({
  point,
  vocabularies,
  equipment,
  selected,
  onSelect,
  onToggleVisible,
  onSaveLabel,
  onSetRole,
  onSetEquipment,
  onNewEquipment,
  onApplySuggestion,
  busy,
}: {
  point: SettingsPoint;
  vocabularies: BasVocabularies | null;
  equipment: SettingsEquipment[] | null;
  /** Null when there is no selection column. */
  selected: boolean | null;
  onSelect?: (checked: boolean) => void;
  onToggleVisible?: (point: SettingsPoint, visible: boolean) => void;
  onSaveLabel?: (point: SettingsPoint, label: string | null) => Promise<void>;
  onSetRole?: (point: SettingsPoint, role: string | null) => Promise<void>;
  onSetEquipment?: (point: SettingsPoint, equipmentId: string | null) => Promise<void>;
  onNewEquipment?: (point: SettingsPoint) => void;
  onApplySuggestion?: (point: SettingsPoint) => Promise<void>;
  busy: boolean;
}) {
  const collected = describeCollected(point);
  const completeness = describePointCompleteness(point);
  const name = pointDisplayName(point);

  return (
    <tr className="border-t border-[var(--border)] align-top">
      {selected !== null && (
        <td className="py-1 pr-2">
          <input
            type="checkbox"
            checked={selected}
            disabled={busy}
            aria-label={`Select ${name}`}
            onChange={(event) => onSelect?.(event.target.checked)}
          />
        </td>
      )}
      <td className="py-1 pr-3">
        <LabelCell point={point} onSave={onSaveLabel} />
      </td>
      <td className="py-1 pr-3 font-mono">{point.niagaraHistoryName}</td>
      <td className="py-1 pr-3">{point.niagaraDisplayName ?? EMPTY}</td>
      <td className="py-1 pr-3">
        <RoleCell point={point} vocabularies={vocabularies} onSet={onSetRole} busy={busy} />
      </td>
      <td className="py-1 pr-3">
        <EquipmentCell
          point={point}
          equipment={equipment}
          onSet={onSetEquipment}
          onNew={onNewEquipment}
          busy={busy}
        />
      </td>
      <td className="py-1 pr-3">
        <SuggestionCell point={point} onApply={onApplySuggestion} busy={busy} />
      </td>
      <td className="py-1 pr-3">
        <span style={{ color: TONE_INK[collected.tone] }}>{collected.label}</span>
        {collected.detail !== null && (
          <span className="text-[var(--muted)]"> · {collected.detail}</span>
        )}
      </td>
      <td className="py-1 pr-3" style={{ color: TONE_INK[completeness.tone] }}>
        {completeness.label}
      </td>
      <td className="py-1 pr-3 tabular-nums">
        <HorizonCell horizon={point.horizon} />
      </td>
      <td className="py-1">
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={point.visible}
            readOnly={onToggleVisible === undefined}
            onChange={(event) => onToggleVisible?.(point, event.target.checked)}
            aria-label={`Show ${name} on the browsing screens`}
          />
          {point.visible ? "Shown" : "Hidden"}
        </label>
      </td>
    </tr>
  );
}

/**
 * The role picker (B8.5): the 91 roles in four groups, with "No role" first.
 * Text when there is no handler or no vocabulary. The change is sent at once
 * - a select has no half-typed state worth a Save button - and the list is
 * refetched, so the cell shows what the database holds.
 */
function RoleCell({
  point,
  vocabularies,
  onSet,
  busy,
}: {
  point: SettingsPoint;
  vocabularies: BasVocabularies | null;
  onSet?: (point: SettingsPoint, role: string | null) => Promise<void>;
  busy: boolean;
}) {
  const groups = useMemo(
    () => (vocabularies === null ? [] : groupRoles(vocabularies.roles)),
    [vocabularies],
  );
  if (onSet === undefined || vocabularies === null) {
    return (
      <span title={point.pointRole ?? undefined}>
        {point.roleName ?? point.pointRole ?? EMPTY}
      </span>
    );
  }
  return (
    <select
      className={FIELD}
      value={point.pointRole ?? ""}
      disabled={busy}
      aria-label={`Role for ${pointDisplayName(point)}`}
      title={point.pointRole ?? "No role. Nobody has looked at this point yet."}
      onChange={(event) => void onSet(point, event.target.value === "" ? null : event.target.value)}
    >
      <option value="">No role</option>
      {groups.map((group) => (
        <optgroup key={group.key} label={group.label}>
          {group.roles.map((role) => (
            <option key={role.pointRole} value={role.pointRole} title={role.description}>
              {role.displayName}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/**
 * The equipment picker (B8.5): the building's equipment, "None", and "New
 * equipment…", which opens the inline form. Text when there is no handler.
 * A station with no building has no equipment to offer and the cell says so.
 */
function EquipmentCell({
  point,
  equipment,
  onSet,
  onNew,
  busy,
}: {
  point: SettingsPoint;
  equipment: SettingsEquipment[] | null;
  onSet?: (point: SettingsPoint, equipmentId: string | null) => Promise<void>;
  onNew?: (point: SettingsPoint) => void;
  busy: boolean;
}) {
  if (onSet === undefined) {
    return <>{point.equipmentName ?? EMPTY}</>;
  }
  if (equipment === null) {
    return (
      <span
        className="text-[var(--muted)]"
        title="This station is attached to no building. Equipment belongs to a building, so attach the station first."
      >
        {point.equipmentName ?? "No building"}
      </span>
    );
  }
  return (
    <select
      className={FIELD}
      value={point.equipmentId ?? ""}
      disabled={busy}
      aria-label={`Equipment for ${pointDisplayName(point)}`}
      onChange={(event) => {
        const value = event.target.value;
        if (value === "__new__") {
          onNew?.(point);
          return;
        }
        void onSet(point, value === "" ? null : value);
      }}
    >
      <option value="">None</option>
      {equipment.map((item) => (
        <option key={item.equipmentId} value={item.equipmentId}>
          {item.name}
          {item.equipTypeName !== null ? ` (${item.equipTypeName})` : ""}
        </option>
      ))}
      {onNew !== undefined && <option value="__new__">New equipment…</option>}
    </select>
  );
}

/**
 * The suggestion, as a sentence and a button (B8.5). Nothing happens until
 * the button is clicked. A point with no confident pattern renders a dash,
 * and that dash is the whole point of the Temp1-Temp3 test.
 */
function SuggestionCell({
  point,
  onApply,
  busy,
}: {
  point: SettingsPoint;
  onApply?: (point: SettingsPoint) => Promise<void>;
  busy: boolean;
}) {
  if (point.suggestion === null) return EMPTY;
  const text = describeSuggestion(point.suggestion);
  return (
    <span className="inline-flex flex-wrap items-center gap-1" title={point.suggestion.confidence}>
      <span>{text}</span>
      {onApply !== undefined && (
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          aria-label={`Apply the suggestion ${text} to ${pointDisplayName(point)}`}
          onClick={() => void onApply(point)}
        >
          Apply
        </button>
      )}
    </span>
  );
}

/**
 * The Label cell (B8.4): text until clicked, then an input with Save and
 * Cancel. Enter saves, Escape cancels. Saving a blank clears the label, and
 * the cell says so rather than leaving a person to wonder whether an empty
 * box is "no change" or "no label".
 *
 * The input is seeded with the current label, never with the Niagara name:
 * pre-filling it with the fallback would invite people to save the station's
 * own name as a label, which is a copy that stops tracking discover.
 */
function LabelCell({
  point,
  onSave,
}: {
  point: SettingsPoint;
  onSave?: (point: SettingsPoint, label: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(point.label ?? "");
  const [saving, setSaving] = useState(false);

  if (onSave === undefined) {
    return point.label ?? EMPTY;
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="rounded px-1 text-left hover:underline"
        title={
          point.label === null
            ? "Add a label. Until one is set, the browsing screens use the station's name."
            : "Edit the label"
        }
        aria-label={`Edit the label for ${pointDisplayName(point)}`}
        onClick={() => {
          setDraft(point.label ?? "");
          setEditing(true);
        }}
      >
        {point.label ?? <span className="text-[var(--muted)]">Add label</span>}
      </button>
    );
  }

  const commit = async () => {
    const next = draft.trim().length === 0 ? null : draft.trim();
    setSaving(true);
    try {
      await onSave(point, next);
      setEditing(false);
    } catch {
      // The list-level banner has the message; the cell stays open so
      // nothing typed is lost.
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <input
        className="w-44 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-xs"
        type="text"
        value={draft}
        maxLength={120}
        disabled={saving}
        autoFocus
        aria-label={`Label for ${point.niagaraHistoryName}`}
        placeholder={point.niagaraDisplayName ?? point.niagaraHistoryName}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setEditing(false);
          }
        }}
      />
      <button
        type="button"
        className={BUTTON}
        disabled={saving}
        onClick={() => void commit()}
      >
        {draft.trim().length === 0 && point.label !== null ? "Clear label" : "Save"}
      </button>
      <button type="button" className={BUTTON} disabled={saving} onClick={() => setEditing(false)}>
        Cancel
      </button>
    </span>
  );
}

// -------------------------------------------------------------- equipment

/**
 * The building's equipment, under the Points list (B8.5): name, type, parent,
 * notes, how many points, Edit and Delete. Collapsed by default - the list is
 * about points - and carrying its own counting guard like every list here.
 */
function EquipmentPanel({
  equipment,
  open,
  onToggle,
  onNew,
  onEdit,
  onDelete,
  busy,
}: {
  equipment: BuildingEquipmentList | null;
  open: boolean;
  onToggle: () => void;
  onNew: () => void;
  onEdit: (item: SettingsEquipment) => void;
  onDelete: (item: SettingsEquipment) => void;
  busy: boolean;
}) {
  const count = equipment?.equipment.length ?? 0;
  const alarm =
    equipment !== null && pointsCountState(equipment.equipmentAccountedFor).alarm;
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BUTTON} aria-expanded={open} onClick={onToggle}>
          {open ? "Hide equipment" : `Equipment in this building (${count})`}
        </button>
        <button type="button" className={BUTTON} disabled={busy} onClick={onNew}>
          New equipment
        </button>
      </div>
      {alarm && equipment !== null && (
        <p className="rounded-md border p-3 text-xs" style={TONE_STYLE.bad} role="alert">
          This list shows {equipment.equipmentAccountedFor.rendered} of the{" "}
          {equipment.equipmentAccountedFor.inDatabase} pieces of equipment the database
          holds for this building. Report this.
        </p>
      )}
      {open && equipment !== null && (
        equipment.equipment.length === 0 ? (
          <p className="text-xs text-[var(--muted)]">
            No equipment in this building yet. Create the air handler or rooftop unit
            first, then the boxes it serves with it as their parent.
          </p>
        ) : (
          <div className="max-h-72 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left text-[var(--muted)]">
                <tr>
                  <th className="py-1 pr-3 font-medium">Name</th>
                  <th className="py-1 pr-3 font-medium">Type</th>
                  <th className="py-1 pr-3 font-medium" title="The equipment this one is served by: a VAV box under its rooftop unit.">
                    Under
                  </th>
                  <th className="py-1 pr-3 font-medium">Notes</th>
                  <th className="py-1 pr-3 font-medium">Points</th>
                  <th className="py-1 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {equipment.equipment.map((item) => (
                  <tr key={item.equipmentId} className="border-t border-[var(--border)] align-top">
                    <td className="py-1 pr-3">{item.name}</td>
                    <td className="py-1 pr-3">{item.equipTypeName ?? item.equipType ?? EMPTY}</td>
                    <td className="py-1 pr-3">{item.parentName ?? EMPTY}</td>
                    <td className="py-1 pr-3">{item.notes ?? EMPTY}</td>
                    <td className="py-1 pr-3 tabular-nums">{item.pointCount}</td>
                    <td className="py-1">
                      <span className="inline-flex gap-1">
                        <button type="button" className={BUTTON} disabled={busy} onClick={() => onEdit(item)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className={BUTTON}
                          disabled={busy || item.pointCount > 0}
                          title={
                            item.pointCount > 0
                              ? `${item.pointCount} ${item.pointCount === 1 ? "point is" : "points are"} attached. Detach them first.`
                              : undefined
                          }
                          onClick={() => onDelete(item)}
                        >
                          Delete
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

interface EquipmentValues {
  name: string;
  equipType: string;
  parentEquipmentId: string;
  notes: string;
}

/**
 * Create or edit equipment inline (B8.5): name, type from the vocabulary,
 * optional parent on the same building, optional notes. The parent is a
 * select over the building's equipment minus itself, so a VAV can be put
 * under the RTU at creation or afterwards.
 */
function EquipmentForm({
  state,
  vocabularies,
  equipment,
  busy,
  onSubmit,
  onCancel,
}: {
  state: EquipmentFormState;
  vocabularies: BasVocabularies;
  equipment: SettingsEquipment[];
  busy: boolean;
  onSubmit: (values: EquipmentValues) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<EquipmentValues>({
    name: state.equipment?.name ?? "",
    equipType: state.equipment?.equipType ?? "",
    parentEquipmentId: state.equipment?.parentEquipmentId ?? "",
    notes: state.equipment?.notes ?? "",
  });
  const set = (patch: Partial<EquipmentValues>) =>
    setValues((current) => ({ ...current, ...patch }));
  const parents = equipment.filter((e) => e.equipmentId !== state.equipment?.equipmentId);
  const byCategory = useMemo(() => {
    const map = new Map<string, BasVocabularies["equipmentTypes"]>();
    for (const type of vocabularies.equipmentTypes) {
      const list = map.get(type.category) ?? [];
      list.push(type);
      map.set(type.category, list);
    }
    return [...map.entries()];
  }, [vocabularies]);
  const attaching = state.attachTo.length;

  return (
    <form
      className="mt-3 space-y-2 rounded border border-[var(--border)] p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(values);
      }}
    >
      <h4 className="text-xs font-medium text-[var(--foreground)]">
        {state.mode === "edit" ? `Edit ${state.equipment?.name ?? "equipment"}` : "New equipment"}
        {attaching > 0 &&
          ` - then attach ${attaching} selected ${attaching === 1 ? "point" : "points"} to it`}
      </h4>
      <div className="flex flex-wrap items-end gap-3 text-xs">
        <label className="block text-[var(--muted)]">
          Name
          <input
            className={`${FIELD} mt-1 block w-40`}
            type="text"
            value={values.name}
            maxLength={120}
            required
            autoFocus
            placeholder="RTU-1, VAV-3"
            onChange={(e) => set({ name: e.target.value })}
          />
        </label>
        <label className="block text-[var(--muted)]">
          Type
          <select
            className={`${FIELD} mt-1 block`}
            value={values.equipType}
            required
            onChange={(e) => set({ equipType: e.target.value })}
          >
            <option value="">Choose a type…</option>
            {byCategory.map(([category, types]) => (
              <optgroup key={category} label={category.replace(/_/g, " ")}>
                {types.map((type) => (
                  <option key={type.equipType} value={type.equipType}>
                    {type.displayName}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="block text-[var(--muted)]">
          Under (optional)
          <select
            className={`${FIELD} mt-1 block`}
            value={values.parentEquipmentId}
            onChange={(e) => set({ parentEquipmentId: e.target.value })}
          >
            <option value="">No parent</option>
            {parents.map((item) => (
              <option key={item.equipmentId} value={item.equipmentId}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[var(--muted)]">
          Notes (optional)
          <input
            className={`${FIELD} mt-1 block w-48`}
            type="text"
            value={values.notes}
            maxLength={2000}
            placeholder="Serves 130-132"
            onChange={(e) => set({ notes: e.target.value })}
          />
        </label>
        <button type="submit" className={BUTTON} disabled={busy || values.name.trim() === "" || values.equipType === ""}>
          {state.mode === "edit" ? "Save" : "Create"}
        </button>
        <button type="button" className={BUTTON} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

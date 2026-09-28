"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  pointDisplayName,
  pointMatchesSearch,
  pointsCountState,
  settingsCountState,
} from "@/lib/modules/bas/types";
import type {
  BasSettingsTree,
  SettingsBuilding,
  SettingsPoint,
  SettingsProject,
  SettingsStation,
  StationPointsList,
} from "@/lib/modules/bas/types";
import {
  ApiError,
  COMMON_TIMEZONES,
  clearStationCredential,
  createBuilding,
  createProject,
  createStation,
  deleteBuilding,
  deleteProject,
  deleteStation,
  describeActivity,
  describeCollected,
  describeLogin,
  describePointCompleteness,
  describeReach,
  fetchBasSettings,
  fetchStationPoints,
  formatTimestamp,
  updatePointLabel,
  updatePointVisibility,
  setStationCredential,
  updateBuilding,
  updateProject,
  updateStation,
} from "./health-client";
import {
  CRED_PARAM,
  MODE_PARAM,
  SEARCH_PARAM,
  STATE_PARAM,
  readSettingsFilters,
  settingsQuery,
  withFilter,
} from "./filters";
import { TONE_INK, TONE_STYLE } from "./tone";
import { HorizonCell } from "./collection-health";

/**
 * Settings - what this platform collects from, and the forms that change it.
 *
 * B7.3 added projects and buildings; B7.4 added stations and their Niagara
 * logins.
 *
 * A password leaves the browser exactly once, on the way into
 * `setStationCredential`. Nothing in this file can read one back, because no
 * route returns one - the credential panel renders a masked placeholder and a
 * Replace button rather than a populated field, and that is a consequence of
 * the API shape rather than a decision made here.
 *
 * There is no "test connection" button anywhere on this screen. It would open a
 * socket from wherever the platform runs, which works on a laptop on the
 * building network and breaks permanently in Azure - which cannot reach the
 * building network, and by Tridium's own guidance must not. Each station row
 * instead shows what the collector actually recorded, which is true from
 * anywhere.
 *
 * Every write refetches the whole tree rather than patching local state. The
 * tree is a dozen rows, the screen is used a handful of times a year, and
 * reconciling by hand is how a UI ends up disagreeing with the database about
 * what was just saved.
 *
 * Errors are shown as the server wrote them. The service composes messages that
 * name the collision or count what is in the way ("still has 2 buildings"), and
 * the person reading them has no other way to look.
 */
export function BasSettings() {
  const [tree, setTree] = useState<BasSettingsTree | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  // The filters ARE the URL. Nothing here mirrors them into component state,
  // so a refresh, a bookmark and a tab switch all reproduce the same screen -
  // the same reason the other two tabs keep their time range and building
  // selection there.
  const filters = useMemo(() => readSettingsFilters(params), [params]);
  const query = useMemo(() => settingsQuery(filters), [filters]);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      // replace, not push: typing in a search box should not fill the back
      // button with one entry per keystroke.
      router.replace(`${pathname}${withFilter(params, key, value)}`, {
        scroll: false,
      });
    },
    [router, pathname, params],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setTree(await fetchBasSettings(query, signal));
        setError(null);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError("unexpected", "Something went wrong."),
        );
      }
    },
    [query],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /**
   * Run a write, then reload.
   *
   * The error is cleared first and set on failure, so a message from a previous
   * attempt never sits above a form that has since succeeded.
   */
  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await load();
        return true;
      } catch (cause) {
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError("unexpected", "Something went wrong."),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (tree === null) {
    return (
      <p className="p-6 text-sm text-[var(--muted)]">
        {error?.message ?? "Loading settings…"}
      </p>
    );
  }

  const { rendered, matched, inDatabase, filtered } =
    tree.stationsAccountedFor;

  /**
   * THE TRAP, and the reason this is two separate conditions.
   *
   * B7.2 turned the screen red when the tree held fewer stations than the
   * database did, to catch a bad join silently dropping rows. Filtering hides
   * rows on purpose, so comparing against the UNFILTERED count would make that
   * alarm fire on every keystroke - and a false alarm is how somebody learns
   * to ignore a real one.
   *
   * So: red is `rendered !== matched`, where `matched` is counted by a separate
   * query applying the same filter. That still means what it always meant -
   * the tree lost stations nobody asked it to lose. `matched < inDatabase` is
   * a filter working, and it is plain text.
   */
  const { alarm: mismatch, hiding } = settingsCountState(
    tree.stationsAccountedFor,
  );

  return (
    <div className="space-y-6">
      {error !== null && (
        <p
          className="rounded-md border p-4 text-sm"
          style={TONE_STYLE.bad}
          role="alert"
        >
          {error.message}
        </p>
      )}

      {/*
        The accounting check, said out loud only when it fails. A tree that
        quietly drops a station is the failure this screen exists to prevent, so
        it is not enough for the query to be right - the screen states that what
        it drew is everything there is.
      */}
      {mismatch && (
        <p className="rounded-md border p-4 text-sm" style={TONE_STYLE.bad}>
          This tree shows {rendered} of the {matched} stations that match, so{" "}
          {matched - rendered} could not be placed in the hierarchy and are not
          on this screen. Report this - a station missing from Settings may
          still be collecting. This is not the filter: it is counted after the
          filter is applied.
        </p>
      )}

      <SettingsControls
        filters={filters}
        setParam={setParam}
        busy={busy}
        summary={
          hiding
            ? `Showing ${matched} of ${inDatabase} stations.`
            : `${inDatabase} station${inDatabase === 1 ? "" : "s"}.`
        }
      />

      {tree.unassignedStations.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-[var(--foreground)]">
            Discovered, unassigned
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Collecting, but attached to no building. Almost certainly JACEs
            linked in Workbench that nobody has labelled here yet.
          </p>
          <ul className="mt-3 space-y-2">
            {tree.unassignedStations.map((station) => (
              <li key={station.stationId}>
                <StationRow
                  station={station}
                  tree={tree}
                  busy={busy}
                  run={run}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <NewProject orgs={tree.orgs} busy={busy} run={run} />

      {tree.projects.length === 0 ? (
        <p className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-6 text-sm text-[var(--muted)]">
          {filtered
            ? "Nothing matches. Clear the search or the filters."
            : "No projects yet. Create one above to add a building under it."}
        </p>
      ) : (
        /*
          Capped and scrolled. This is planned to hold hundreds of stations
          across many projects, and an unbounded list pushes the search box
          that finds them off the top of the screen.

          Scrolling alone would not be enough - a tall box of fully expanded
          projects is no more usable than a tall page - which is why the cards
          collapse too.
        */
        <ul className="max-h-[42rem] space-y-6 overflow-y-auto pr-1">
          {tree.projects.map((project) => (
            <li key={project.projectId}>
              <ProjectCard
                project={project}
                tree={tree}
                busy={busy}
                run={run}
                // Expanded when there are few enough to read at once, which
                // keeps today's single project opening exactly as it did. Above
                // that, collapsed - and a search overrides both, because a
                // result you cannot see has not been found.
                defaultOpen={tree.projects.length <= 2}
                forceOpen={filtered}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Run = (action: () => Promise<unknown>) => Promise<boolean>;

// --------------------------------------------------------------------- forms

const FIELD =
  "mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm";
const BUTTON =
  "rounded border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-50";

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block text-xs font-medium text-[var(--muted)]">
      {label}
      {children}
      {hint !== undefined && (
        <span className="mt-1 block font-normal text-[var(--muted)]">{hint}</span>
      )}
    </label>
  );
}

function NewProject({
  orgs,
  busy,
  run,
}: {
  orgs: BasSettingsTree["orgs"];
  busy: boolean;
  run: Run;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [orgId, setOrgId] = useState(orgs[0]?.orgId ?? "");

  // No orgs means nothing to hang a project on. Organisations are not managed
  // on this screen, so the honest answer is to say so rather than to offer a
  // form that cannot succeed.
  if (orgs.length === 0) {
    return (
      <p className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--muted)]">
        No organisation exists yet, so a project cannot be created. Organisations
        are not managed here - contact IT.
      </p>
    );
  }

  if (!open) {
    return (
      <button type="button" className={BUTTON} onClick={() => setOpen(true)}>
        New project
      </button>
    );
  }

  return (
    <form
      className="space-y-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const ok = await run(() => createProject({ orgId, name }));
        if (ok) {
          setName("");
          setOpen(false);
        }
      }}
    >
      <h2 className="text-sm font-medium text-[var(--foreground)]">New project</h2>

      <Field label="Name">
        <input
          className={FIELD}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
        />
      </Field>

      {/*
        Rendered even with one organisation. Preselected, so it costs a glance
        rather than a decision - but a form that silently picked an org the day
        a second one appeared is the invented-data failure this project keeps
        writing rules about.
      */}
      <Field label="Organisation">
        <select
          className={FIELD}
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
        >
          {orgs.map((org) => (
            <option key={org.orgId} value={org.orgId}>
              {org.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex gap-2">
        <button type="submit" className={BUTTON} disabled={busy}>
          Create
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ProjectCard({
  project,
  tree,
  busy,
  run,
  defaultOpen,
  forceOpen,
}: {
  project: SettingsProject;
  tree: BasSettingsTree;
  busy: boolean;
  run: Run;
  defaultOpen: boolean;
  /** A search is active, so everything returned matched and should be visible. */
  forceOpen: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [addingBuilding, setAddingBuilding] = useState(false);
  const [open, setOpen] = useState(defaultOpen);

  // Expansion is component state rather than URL state, deliberately: it is a
  // reading affordance and not a filter. Nobody bookmarks which cards were
  // open, and putting it in the URL would mean a search had to rewrite it.
  const expanded = forceOpen || open;

  const buildings = project.buildings.length;
  const stations = project.buildings.reduce(
    (total, building) => total + building.stations.length,
    0,
  );

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-5">
      {editing ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await run(() => updateProject(project.projectId, { name })))
              setEditing(false);
          }}
        >
          <div className="min-w-[16rem] flex-1">
            <Field label="Project name">
              <input
                className={FIELD}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
              />
            </Field>
          </div>
          <button type="submit" className={BUTTON} disabled={busy}>
            Save
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => {
              setName(project.name);
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-2">
            {/*
              The whole heading is the toggle, not a separate chevron - a bigger
              target and one obvious thing to click. Disabled while a search is
              active, because collapsing a card the search just surfaced would
              hide the match.
            */}
            <button
              type="button"
              className="text-left disabled:cursor-default"
              aria-expanded={expanded}
              disabled={forceOpen}
              onClick={() => setOpen((current) => !current)}
            >
              <h2 className="text-sm font-medium text-[var(--foreground)]">
                <span
                  aria-hidden="true"
                  className="mr-1.5 inline-block text-[var(--muted)]"
                >
                  {expanded ? "\u25be" : "\u25b8"}
                </span>
                {project.name}
              </h2>
              <p className="mt-0.5 text-xs text-[var(--muted)]">
                {project.orgName}
                {" \u00b7 "}
                {buildings} building{buildings === 1 ? "" : "s"}
                {", "}
                {stations} station{stations === 1 ? "" : "s"}
              </p>
            </button>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              Rename
            </button>
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => void run(() => deleteProject(project.projectId))}
              // No confirmation dialog. The server refuses to delete a project
              // that still has buildings and says how many, so the destructive
              // case cannot be reached by a mis-click - and an empty project is
              // one row that can be recreated in ten seconds.
              title={
                project.buildings.length > 0
                  ? "A project with buildings cannot be deleted."
                  : undefined
              }
            >
              Delete
            </button>
          </div>
        </div>
      )}

      {!expanded ? null : project.buildings.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--muted)]">
          No buildings in this project.
        </p>
      ) : (
        <ul className="mt-4 space-y-4">
          {project.buildings.map((building) => (
            <li
              key={building.siteId}
              className="border-l-2 border-[var(--border)] pl-4"
            >
              <BuildingRow
                building={building}
                tree={tree}
                busy={busy}
                run={run}
              />
            </li>
          ))}
        </ul>
      )}

      <div className={expanded ? "mt-4" : "hidden"}>
        {addingBuilding ? (
          <BuildingForm
            title="New building"
            busy={busy}
            initial={{ name: "", timezone: "America/New_York", address: "" }}
            onCancel={() => setAddingBuilding(false)}
            onSubmit={async (values) => {
              const ok = await run(() =>
                createBuilding({ projectId: project.projectId, ...values }),
              );
              if (ok) setAddingBuilding(false);
              return ok;
            }}
          />
        ) : (
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => setAddingBuilding(true)}
          >
            Add building
          </button>
        )}
      </div>
    </div>
  );
}

function BuildingRow({
  building,
  tree,
  busy,
  run,
}: {
  building: SettingsBuilding;
  tree: BasSettingsTree;
  busy: boolean;
  run: Run;
}) {
  const [editing, setEditing] = useState(false);
  const [addingStation, setAddingStation] = useState(false);

  if (editing) {
    return (
      <BuildingForm
        title={`Edit ${building.name}`}
        busy={busy}
        initial={{
          name: building.name,
          timezone: building.timezone,
          address: building.address ?? "",
        }}
        onCancel={() => setEditing(false)}
        onSubmit={async (values) => {
          const ok = await run(() => updateBuilding(building.siteId, values));
          if (ok) setEditing(false);
          return ok;
        }}
      />
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm text-[var(--foreground)]">{building.name}</h3>
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            {building.timezone}
            {building.address !== null && ` · ${building.address}`}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => void run(() => deleteBuilding(building.siteId))}
          >
            Delete
          </button>
        </div>
      </div>

      {building.stations.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--muted)]">
          No stations in this building.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {building.stations.map((station) => (
            <li key={station.stationId}>
              <StationRow
                station={station}
                tree={tree}
                busy={busy}
                run={run}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3">
        {addingStation ? (
          <StationForm
            title="Register a station"
            initial={emptyStation()}
            stations={tree.allStations}
            busy={busy}
            onCancel={() => setAddingStation(false)}
            onSubmit={async (values) => {
              const ok = await run(() =>
                createStation({
                  siteId: building.siteId,
                  niagaraStationName: values.niagaraStationName,
                  displayName: values.displayName || null,
                  connectionMode: values.connectionMode,
                  baseUrl:
                    values.connectionMode === "direct" ? values.baseUrl : null,
                  parentStationId:
                    values.connectionMode === "via_parent"
                      ? values.parentStationId
                      : null,
                  tlsSha256: values.tlsSha256 || null,
                }),
              );
              if (ok) setAddingStation(false);
              return ok;
            }}
          />
        ) : (
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => setAddingStation(true)}
          >
            Register a station
          </button>
        )}
      </div>
    </>
  );
}

interface BuildingValues {
  name: string;
  timezone: string;
  address: string;
}

function BuildingForm({
  title,
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial: BuildingValues;
  busy: boolean;
  onSubmit: (values: BuildingValues) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(initial);
  const set = (patch: Partial<BuildingValues>) =>
    setValues((current) => ({ ...current, ...patch }));

  return (
    <form
      className="space-y-3 rounded border border-[var(--border)] p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(values);
      }}
    >
      <h3 className="text-sm font-medium text-[var(--foreground)]">{title}</h3>

      <Field label="Name" hint="Unique within this project, not across all of them.">
        <input
          className={FIELD}
          value={values.name}
          onChange={(e) => set({ name: e.target.value })}
          required
          maxLength={120}
        />
      </Field>

      {/*
        An input with a datalist, not a select. The server validates against
        pg_timezone_names, so any real IANA zone is accepted; offering only six
        in a closed control would be a second source of truth that goes stale.
      */}
      <Field
        label="Timezone"
        hint="Display only - every reading is stored in UTC. This is what converts it back to what time it was in the building."
      >
        <input
          className={FIELD}
          list="bas-timezones"
          value={values.timezone}
          onChange={(e) => set({ timezone: e.target.value })}
          required
          maxLength={64}
        />
      </Field>
      <datalist id="bas-timezones">
        {COMMON_TIMEZONES.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>

      <Field label="Address (optional)">
        <input
          className={FIELD}
          value={values.address}
          onChange={(e) => set({ address: e.target.value })}
          maxLength={500}
        />
      </Field>

      <div className="flex gap-2">
        <button type="submit" className={BUTTON} disabled={busy}>
          Save
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function StationRow({
  station,
  tree,
  busy,
  run,
}: {
  station: SettingsStation;
  tree: BasSettingsTree;
  busy: boolean;
  run: Run;
}) {
  const [editing, setEditing] = useState(false);
  const [showPoints, setShowPoints] = useState(false);
  // The tree's search term, read from the URL like every other filter, so
  // the Points list under a station that matched on a point's name opens
  // narrowed to that term (B8.4).
  const initialPointQuery = readSettingsFilters(useSearchParams()).q;
  const reach = describeReach(station);
  const activity = describeActivity(station.activity);
  const login = describeLogin(station);

  if (editing) {
    return (
      <StationForm
        title={`Edit ${station.niagaraStationName}`}
        stations={tree.allStations}
        excludeStationId={station.stationId}
        busy={busy}
        initial={{
          niagaraStationName: station.niagaraStationName,
          displayName: station.displayName ?? "",
          connectionMode: station.reach === "direct" ? "direct" : "via_parent",
          baseUrl: station.baseUrl ?? "",
          parentStationId: station.parentStationId ?? "",
          tlsSha256: station.tlsSha256 ?? "",
        }}
        onCancel={() => setEditing(false)}
        onSubmit={async (values) => {
          const ok = await run(() =>
            updateStation(station.stationId, {
              niagaraStationName: values.niagaraStationName,
              displayName: values.displayName || null,
              connectionMode: values.connectionMode,
              baseUrl:
                values.connectionMode === "direct" ? values.baseUrl : null,
              parentStationId:
                values.connectionMode === "via_parent"
                  ? values.parentStationId
                  : null,
              tlsSha256: values.tlsSha256 || null,
            }),
          );
          if (ok) setEditing(false);
          return ok;
        }}
      />
    );
  }

  return (
    <div className="rounded border border-[var(--border)] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {/*
            The Niagara name, verbatim and in a monospace face. It is
            case-sensitive and appears literally in every oBIX URL, so it is
            shown as the identifier it is rather than titlecased into prose.
          */}
          <span className="font-mono text-sm text-[var(--foreground)]">
            {station.niagaraStationName}
          </span>
          {station.displayName !== null && (
            <span className="text-sm text-[var(--muted)]">
              {station.displayName}
            </span>
          )}
          <span
            className="rounded px-1.5 py-0.5 text-xs"
            style={TONE_STYLE[reach.tone]}
          >
            {reach.label}
          </span>
          {!station.isActive && (
            <span className="text-xs text-[var(--muted)]">inactive</span>
          )}
        </div>
        <div className="flex gap-2">
          {/*
            The Points level (B8.2). Loaded on demand - the count in the label
            is the tree's own direct count, so it is right before anything is
            fetched and a station that is never expanded costs nothing.
          */}
          <button
            type="button"
            className={BUTTON}
            aria-expanded={showPoints}
            onClick={() => setShowPoints((open) => !open)}
          >
            {showPoints
              ? "Hide points"
              : `Points (${station.totalPoints})`}
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => void run(() => deleteStation(station.stationId))}
          >
            Delete
          </button>
        </div>
      </div>

      <p className="mt-1 text-xs" style={{ color: TONE_INK[reach.tone] }}>
        {reach.detail}
      </p>

      {/*
        Whether it is actually collecting, from bas_ingest_runs and
        bas_sync_checkpoints. This is what a "test connection" button would have
        claimed to answer, except that this answer is also true from Azure.
      */}
      <p className="mt-1 text-xs" style={{ color: TONE_INK[activity.tone] }}>
        {activity.label}
      </p>

      {/*
        The login banner. Amber for a station nobody has given a password to
        yet - a backlog, not a fault, and the same sentence the collector logs
        when it skips the station. Red for a station that was collecting and
        has lost its login. Nothing at all when the login is set.
      */}
      {login !== null && (
        <p
          className="mt-1 rounded border px-2 py-1 text-xs"
          style={{ ...TONE_STYLE[login.tone], color: TONE_INK[login.tone] }}
        >
          {login.label}
        </p>
      )}

      <p className="mt-1 text-xs text-[var(--muted)]">
        {station.activePoints} active{" "}
        {station.activePoints === 1 ? "point" : "points"}
        {station.totalPoints !== station.activePoints &&
          ` (${station.totalPoints} total)`}
        {station.tlsSha256 !== null && (
          <>
            {" · "}
            <span title={station.tlsSha256}>
              certificate pinned {station.tlsSha256.slice(0, 12)}…
            </span>
          </>
        )}
        {station.lastSeenAt !== null && (
          <>
            {" · "}last seen {formatTimestamp(station.lastSeenAt)}
          </>
        )}
      </p>

      <CredentialPanel
        station={station}
        available={tree.credentialStorage.available}
        unavailableMessage={tree.credentialStorage.message}
        // The banner above already says there is no login, in the words
        // that matter. Saying it a second time here in different words is
        // how one state starts to look like two.
        quiet={login !== null}
        busy={busy}
        run={run}
      />

      {showPoints && (
        <StationPoints
          stationId={station.stationId}
          expectedTotal={station.totalPoints}
          initialQuery={initialPointQuery}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------- points

/**
 * The Points level, fetched when its station is expanded (B8.2).
 *
 * A row is mounted per station and unmounted when the station collapses, so
 * the fetch runs once per expansion and the abort on unmount is what stops a
 * slow response landing on a row that is no longer open.
 */
function StationPoints({
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
  const [error, setError] = useState<ApiError | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [query, setQuery] = useState(initialQuery);

  /**
   * The label (B8.4). NOT optimistic, unlike the checkbox: the server trims
   * and normalises what was typed, and the row should show what the database
   * holds rather than what the input held. The cell stays in its editing
   * state until the answer arrives.
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
        setSaveError(cause instanceof ApiError ? cause.message : "Something went wrong.");
        throw cause;
      }
    },
    [],
  );

  /**
   * The Shown checkbox (B8.3). Optimistic: flip the row, call the API, flip
   * it back if that fails. Hiding is cosmetic and reversible, so there is
   * nothing here worth a confirmation - the point is collected either way.
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
      setSaveError(cause instanceof ApiError ? cause.message : "Something went wrong.");
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchStationPoints(stationId, controller.signal).then(
      (loaded) => setList(loaded),
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError("unexpected", "Something went wrong."),
        );
      },
    );
    return () => controller.abort();
  }, [stationId]);

  if (error !== null) {
    return (
      <p
        className="mt-3 rounded-md border p-3 text-xs"
        style={TONE_STYLE.bad}
        role="alert"
      >
        {error.message}
      </p>
    );
  }
  if (list === null) {
    return <p className="mt-3 text-xs text-[var(--muted)]">Loading points…</p>;
  }
  return (
    <>
      {saveError !== null && (
        <p
          className="mt-3 rounded-md border p-3 text-xs"
          style={TONE_STYLE.bad}
          role="alert"
        >
          Could not save that change: {saveError} The row shows what the
          database still holds.
        </p>
      )}
      <PointsTable
        list={list}
        expectedTotal={expectedTotal}
        query={query}
        onQueryChange={setQuery}
        onToggleVisible={toggleVisible}
        onSaveLabel={saveLabel}
      />
    </>
  );
}

const EMPTY = <span className="text-[var(--muted)]">—</span>;

/**
 * The list itself. Pure - no fetch, no hooks - so tests/bas-settings-points
 * can render it with a payload whose counts disagree and read the alarm off
 * the HTML, which is the only way to prove the screen SAYS it when the list
 * falls short. Exported for that reason and used by nothing else.
 *
 * EVERYTHING the service returned is drawn. Nothing here filters on
 * `collected` or on `visible`: an uncollected point is the row somebody most
 * needs to see, and a HIDDEN point must stay on this list too - this is
 * where it gets shown again (B8.3). Hiding removes a point from Point
 * Explorer and the Collection Health table, never from here and never from
 * a total.
 *
 * The one thing that does narrow the rows is the search box (B8.4), and it
 * narrows what is DRAWN, not what was fetched: the counts above the table
 * are still the service's, the alarm still compares the service's two
 * numbers, and the search reports its own "N of M match" beside them. It
 * matches any of a point's three names, so a name pasted out of Workbench
 * finds a point the screen calls something else.
 */
export function PointsTable({
  list,
  expectedTotal,
  query = "",
  onQueryChange,
  onToggleVisible,
  onSaveLabel,
}: {
  list: StationPointsList;
  /** The tree's own count for the row above, so a stale tree is named as such. */
  expectedTotal: number;
  /** The search term. Blank draws every row. */
  query?: string;
  /** Absent in a static render; the search box is then read-only. */
  onQueryChange?: (query: string) => void;
  /** Absent in a static render; the checkbox is then read-only. */
  onToggleVisible?: (point: SettingsPoint, visible: boolean) => void;
  /** Absent in a static render; the label is then plain text. */
  onSaveLabel?: (point: SettingsPoint, label: string | null) => Promise<void>;
}) {
  const { rendered, inDatabase } = list.pointsAccountedFor;
  const { alarm } = pointsCountState(list.pointsAccountedFor);
  const missing = inDatabase - rendered;
  const noun = (n: number) => (n === 1 ? "point" : "points");
  const searching = query.trim().length > 0;
  const shown = searching
    ? list.points.filter((point) => pointMatchesSearch(point, query))
    : list.points;

  return (
    <div className="mt-3 space-y-2">
      {/*
        The accounting check, said out loud only when it fails. `inDatabase` is
        counted by a query with no joins; `rendered` is what the joined list
        query returned. A list that quietly dropped a point would teach people
        to trust it, which is worse than having no list.
      */}
      {alarm && (
        <p
          className="rounded-md border p-3 text-xs"
          style={TONE_STYLE.bad}
          role="alert"
        >
          This list shows {rendered} of the {inDatabase} {noun(inDatabase)} the
          database holds for this station, so {missing} could not be placed and{" "}
          {missing === 1 ? "is" : "are"} not on this screen. Report this - a
          point missing from Settings may still be collecting, or may have
          stopped.
        </p>
      )}

      {/*
        Not red: the tree's count and the list's count are two queries taken at
        two moments, and a discover run between them is not a fault. The tree is
        what is stale, and the fix is a reload.
      */}
      {!alarm && inDatabase !== expectedTotal && (
        <p className="text-xs text-[var(--muted)]">
          The tree counted {expectedTotal} {noun(expectedTotal)} for this
          station when it loaded; the database now holds {inDatabase}. Reload
          to refresh the station row.
        </p>
      )}

      {list.points.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">
          No points registered. Run discover against this station to register
          its histories.
        </p>
      ) : (
        <div className="overflow-x-auto">
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
            {searching && (
              <span className="text-xs text-[var(--muted)]">
                {shown.length} of {list.points.length} {noun(list.points.length)}{" "}
                match
              </span>
            )}
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--muted)]">
                <th
                  className="py-1 pr-3 font-medium"
                  title="What a person calls this point. Shown in Point Explorer and Collection Health in place of the station's name. Blank means the station's name is used."
                >
                  Label
                </th>
                <th className="py-1 pr-3 font-medium">Niagara name</th>
                <th
                  className="py-1 pr-3 font-medium"
                  title="What the station reports for this history. Not the person's label - that is the Label column."
                >
                  Station name
                </th>
                <th className="py-1 pr-3 font-medium">Role</th>
                <th className="py-1 pr-3 font-medium">Equipment</th>
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
                  title="Whether the point appears in Point Explorer and the Collection Health table. It is collected either way, and it counts in every risk figure either way."
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
                  onToggleVisible={onToggleVisible}
                  onSaveLabel={onSaveLabel}
                />
              ))}
              {searching && shown.length === 0 && (
                <tr className="border-t border-[var(--border)]">
                  <td className="py-2 text-[var(--muted)]" colSpan={9}>
                    No point on this station matches &ldquo;{query.trim()}&rdquo; by
                    label, station name or Niagara name. Clear the search to see
                    all {list.points.length}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-[var(--muted)]">
        {inDatabase} {noun(inDatabase)} in the database for this station,{" "}
        {rendered} listed. Unticking Shown hides a point from Point Explorer
        and the Collection Health table only - it is still collected and still
        counts in every risk figure. A label replaces the station&apos;s name
        on those screens and nowhere else; the Niagara name is never editable,
        because it is what the collector asks the station for. Roles and
        equipment are edited in a later phase.
      </p>
    </div>
  );
}

function PointRow({
  point,
  onToggleVisible,
  onSaveLabel,
}: {
  point: SettingsPoint;
  onToggleVisible?: (point: SettingsPoint, visible: boolean) => void;
  onSaveLabel?: (point: SettingsPoint, label: string | null) => Promise<void>;
}) {
  const collected = describeCollected(point);
  const completeness = describePointCompleteness(point);

  return (
    <tr className="border-t border-[var(--border)] align-top">
      <td className="py-1 pr-3">
        <LabelCell point={point} onSave={onSaveLabel} />
      </td>
      {/*
        The oBIX key, verbatim and monospace, escapes and all - it is what you
        match against Workbench when something breaks, and shown in full for
        that reason.
      */}
      <td className="py-1 pr-3 font-mono">{point.niagaraHistoryName}</td>
      <td className="py-1 pr-3">{point.niagaraDisplayName ?? EMPTY}</td>
      <td className="py-1 pr-3" title={point.pointRole ?? undefined}>
        {point.roleName ?? point.pointRole ?? EMPTY}
      </td>
      <td className="py-1 pr-3">{point.equipmentName ?? EMPTY}</td>
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
            aria-label={`Show ${pointDisplayName(point)} on the browsing screens`}
          />
          {point.visible ? "Shown" : "Hidden"}
        </label>
      </td>
    </tr>
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
        className="rounded border border-[var(--border)] px-1.5 py-0.5 text-xs disabled:opacity-50"
        disabled={saving}
        onClick={() => void commit()}
      >
        {draft.trim().length === 0 && point.label !== null ? "Clear label" : "Save"}
      </button>
      <button
        type="button"
        className="rounded border border-[var(--border)] px-1.5 py-0.5 text-xs disabled:opacity-50"
        disabled={saving}
        onClick={() => setEditing(false)}
      >
        Cancel
      </button>
    </span>
  );
}

// ------------------------------------------------------------ stations

interface StationValues {
  niagaraStationName: string;
  displayName: string;
  connectionMode: "direct" | "via_parent";
  baseUrl: string;
  parentStationId: string;
  tlsSha256: string;
}

function emptyStation(): StationValues {
  return {
    niagaraStationName: "",
    displayName: "",
    // via_parent is the mode that takes no action, and the default the column
    // itself uses. A form defaulting to 'direct' would describe a station as
    // something we connect to before anyone has said so.
    connectionMode: "via_parent",
    baseUrl: "",
    parentStationId: "",
    tlsSha256: "",
  };
}

function StationForm({
  title,
  initial,
  stations,
  excludeStationId,
  busy,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial: StationValues;
  stations: BasSettingsTree["allStations"];
  /** The station being edited, which may not be offered as its own parent. */
  excludeStationId?: string;
  busy: boolean;
  onSubmit: (values: StationValues) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(initial);
  const set = (patch: Partial<StationValues>) =>
    setValues((current) => ({ ...current, ...patch }));

  const parents = stations.filter((s) => s.stationId !== excludeStationId);

  return (
    <form
      className="space-y-3 rounded border border-[var(--border)] p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(values);
      }}
    >
      <h3 className="text-sm font-medium text-[var(--foreground)]">{title}</h3>

      {/*
        The identifier. Stored byte for byte - the note says so, because
        somebody will otherwise "tidy" the capitalisation and every oBIX request
        will 404 with nothing pointing here.
      */}
      <Field
        label="Niagara station name"
        hint="Exactly as Niagara spells it, including capitals. It appears literally in every oBIX URL and is stored unchanged."
      >
        <input
          className={`${FIELD} font-mono`}
          value={values.niagaraStationName}
          onChange={(e) => set({ niagaraStationName: e.target.value })}
          required
          maxLength={120}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </Field>

      <Field label="Display name (optional)" hint="What people call it. Free text.">
        <input
          className={FIELD}
          value={values.displayName}
          onChange={(e) => set({ displayName: e.target.value })}
          maxLength={120}
        />
      </Field>

      <Field label="How its history reaches us">
        <select
          className={FIELD}
          value={values.connectionMode}
          onChange={(e) =>
            set({ connectionMode: e.target.value as StationValues["connectionMode"] })
          }
        >
          <option value="via_parent">
            Imported by another station (via parent)
          </option>
          <option value="direct">The collector connects to it (direct)</option>
        </select>
      </Field>

      {values.connectionMode === "direct" ? (
        <>
          <Field
            label="Address"
            hint="Stored exactly as typed. The lab station is https://196.1.1.213 with no trailing slash - adding one produces //obix."
          >
            <input
              className={`${FIELD} font-mono`}
              value={values.baseUrl}
              onChange={(e) => set({ baseUrl: e.target.value })}
              required
              maxLength={500}
              spellCheck={false}
            />
          </Field>

          <Field
            label="TLS certificate fingerprint (optional)"
            hint="SHA-256, 64 hex characters. Colons and capitals are ignored. The JACE is self-signed, so pinning this is how verification can ever be switched on - recording it here does not switch it on."
          >
            <input
              className={`${FIELD} font-mono`}
              value={values.tlsSha256}
              onChange={(e) => set({ tlsSha256: e.target.value })}
              maxLength={200}
              spellCheck={false}
            />
          </Field>
        </>
      ) : (
        <Field
          label="Imported by"
          hint="The station whose history import carries this one. Usually the central station for the property."
        >
          <select
            className={FIELD}
            value={values.parentStationId}
            onChange={(e) => set({ parentStationId: e.target.value })}
            required
          >
            <option value="">Choose a station…</option>
            {parents.map((station) => (
              <option key={station.stationId} value={station.stationId}>
                {station.niagaraStationName} ({station.siteName})
              </option>
            ))}
          </select>
        </Field>
      )}

      {/*
        No "test connection" button, and there must never be one. It would open
        a socket from wherever the platform runs: fine on a laptop on the
        building network, permanently broken once this is in Azure, which cannot
        reach the building network and must not be able to. Whether a station is
        really collecting is shown on the row from the collector's own records.
      */}
      <div className="flex gap-2">
        <button type="submit" className={BUTTON} disabled={busy}>
          Save
        </button>
        <button type="button" className={BUTTON} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The credential form. Write-only.
 *
 * There is nothing to load: the tree already carries the username and when the
 * password last moved, and the password itself has no read path anywhere in the
 * platform. So this renders a masked placeholder and a Replace button rather
 * than a populated field - a form that pre-filled the password would need a
 * route that returned it, and no such route exists.
 */
function CredentialPanel({
  station,
  available,
  unavailableMessage,
  quiet = false,
  busy,
  run,
}: {
  station: SettingsStation;
  available: boolean;
  unavailableMessage: string | null;
  /** True when the row above has already said there is no login. */
  quiet?: boolean;
  busy: boolean;
  run: Run;
}) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState(station.credential?.username ?? "");
  const [password, setPassword] = useState("");

  if (!available) {
    return (
      <p className="mt-2 text-xs" style={{ color: TONE_INK.warn }}>
        {unavailableMessage ??
          "Credential storage is not configured on this server."}
      </p>
    );
  }

  if (!open) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
        {station.credential === null ? (
          quiet ? null : <span>No Niagara login stored.</span>
        ) : (
          <span>
            {station.credential.username} ·{" "}
            {/* Never the value, and never its length. */}
            <span aria-label="password is set">•••••</span> set{" "}
            {formatTimestamp(station.credential.passwordUpdatedAt)}
          </span>
        )}
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() => setOpen(true)}
        >
          {station.credential === null ? "Set login" : "Replace"}
        </button>
        {station.credential !== null && (
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => void run(() => clearStationCredential(station.stationId))}
          >
            Remove
          </button>
        )}
      </div>
    );
  }

  return (
    <form
      className="mt-2 space-y-2 rounded border border-[var(--border)] p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        const ok = await run(() =>
          setStationCredential(station.stationId, { username, password }),
        );
        // Cleared whatever happens. A failed save must not leave the password
        // sitting in a form field for the next person at this desk.
        setPassword("");
        if (ok) setOpen(false);
      }}
    >
      <Field label="Niagara username">
        <input
          className={FIELD}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          maxLength={200}
          autoComplete="off"
        />
      </Field>
      <Field
        label="Password"
        hint="Encrypted before it is stored, and never shown again. Replacing it is the only way to change it."
      >
        <input
          className={FIELD}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          maxLength={1000}
          autoComplete="new-password"
        />
      </Field>
      <div className="flex gap-2">
        <button type="submit" className={BUTTON} disabled={busy}>
          Save login
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() => {
            setPassword("");
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}


/**
 * Search and filters (B7.6).
 *
 * Every control writes to the URL and nothing else. There is no local copy of
 * the search term, so the input is driven by `filters.q` and a refresh
 * reproduces exactly what was on screen - which is the property the other two
 * tabs already have and the reason their filters live there too.
 *
 * The filters are the ones worth having among hundreds of stations: how a
 * station is reached, whether data is actually arriving, and whether anybody
 * has entered its login. Narrowing to one project is what the search box is
 * for, so there is deliberately no project dropdown.
 */
function SettingsControls({
  filters,
  setParam,
  busy,
  summary,
}: {
  filters: { q: string; mode: string | null; state: string | null; cred: string | null };
  setParam: (key: string, value: string | null) => void;
  busy: boolean;
  summary: string;
}) {
  const anyActive =
    filters.q.trim().length > 0 ||
    filters.mode !== null ||
    filters.state !== null ||
    filters.cred !== null;

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[18rem] flex-1">
          <Field
            label="Search"
            hint="Project, building, display name, Niagara name, or address."
          >
            <input
              className={FIELD}
              type="search"
              value={filters.q}
              disabled={busy}
              placeholder="e.g. Spring Grove, SpringGroveLabComputer, 196.1.1"
              onChange={(e) => setParam(SEARCH_PARAM, e.target.value)}
            />
          </Field>
        </div>

        <Select
          label="Reached by"
          value={filters.mode}
          disabled={busy}
          onChange={(v) => setParam(MODE_PARAM, v)}
          options={[
            ["direct", "Direct"],
            ["via_parent", "Via parent"],
            // The work queue, and the reason it is not folded into Via parent:
            // these are the stations nobody has finished configuring.
            ["unconfigured", "Discovered, unassigned"],
          ]}
        />

        <Select
          label="Collection"
          value={filters.state}
          disabled={busy}
          onChange={(v) => setParam(STATE_PARAM, v)}
          options={[
            ["collecting", "Collecting"],
            ["stale", "Stale"],
            ["never", "Never collected"],
          ]}
        />

        <Select
          label="Credentials"
          value={filters.cred}
          disabled={busy}
          onChange={(v) => setParam(CRED_PARAM, v)}
          options={[
            ["set", "Stored"],
            ["unset", "Not stored"],
          ]}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {/*
          Plain text, never a colour. This is a filter reporting what it did.
          The red banner above is for a count that disagrees with the database
          AFTER filtering, which is a different claim entirely.
        */}
        <p className="text-xs text-[var(--muted)]">{summary}</p>
        {anyActive && (
          <button
            type="button"
            className="text-xs underline decoration-dotted"
            onClick={() => {
              setParam(SEARCH_PARAM, null);
              setParam(MODE_PARAM, null);
              setParam(STATE_PARAM, null);
              setParam(CRED_PARAM, null);
            }}
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null;
  options: ReadonlyArray<readonly [string, string]>;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <Field label={label}>
      <select
        className={FIELD}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      >
        {/* Absent IS all, so the empty value clears the parameter. */}
        <option value="">Any</option>
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </Field>
  );
}

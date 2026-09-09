"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { settingsCountState } from "@/lib/modules/bas/types";
import type {
  BasSettingsTree,
  SettingsBuilding,
  SettingsProject,
  SettingsStation,
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
  describeReach,
  fetchBasSettings,
  formatTimestamp,
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
  const reach = describeReach(station);
  const activity = describeActivity(station.activity);

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
        busy={busy}
        run={run}
      />
    </div>
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
  busy,
  run,
}: {
  station: SettingsStation;
  available: boolean;
  unavailableMessage: string | null;
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
          <span>No Niagara login stored.</span>
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

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BasDashboard, DashboardProject } from "@/lib/modules/bas/types";
import { basFigure } from "@/lib/home/bas-figure";
import { ApiError, fetchDashboard } from "./health-client";
import { dashboardCardHref } from "./filters";

/**
 * The Dashboard - the tab the module opens on. One card per project.
 *
 * A card is three facts and a way in: the project's name, its health in the
 * Home tile's words, and how many buildings and JACEs it holds. Clicking it
 * opens Point Explorer with the project set and no point loaded - see
 * `dashboardCardHref`.
 *
 * THE HEALTH LINE IS `basFigure`'s. The same function words the Home tile:
 * "No points at risk", or "N points at risk" in a maroon mark, over the age
 * of the newest reading. The count under it is the service's, decided by the
 * one at-risk predicate scoped to the project; this file never looks at a
 * risk state. A card and Collection Health filtered to its project cannot
 * disagree, and tests/bas-at-risk-predicate.test.ts checks that they do not.
 *
 * Quiet when fine, loud when broken (§ 58): a healthy card is a name, a calm
 * line and two counts. The only things that raise their voice are a project
 * losing data and a card count that disagrees with the database.
 *
 * `DashboardCards` is the whole rendering, exported without the fetch so a
 * node-environment test can drive it with a payload and read the HTML.
 */

const POLL_INTERVAL_MS = 60_000;

export function Dashboard({ canAdminister = false }: { canAdminister?: boolean }) {
  const [data, setData] = useState<BasDashboard | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  // No loading flag: the skeleton shows exactly while there is no payload, and
  // a poll that fails keeps the previous cards under a one-line notice.
  const load = useCallback(async () => {
    try {
      setData(await fetchDashboard());
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(
        caught instanceof ApiError ? caught : new ApiError("unexpected", "Something went wrong."),
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The same poll the other tabs run: only while the tab is visible, and a
  // refresh on return so a card is never a minute stale the moment you look.
  const pollRef = useRef<() => void>(() => {});
  pollRef.current = () => void load();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      if (timer !== null || document.visibilityState !== "visible") return;
      timer = setInterval(() => pollRef.current(), POLL_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        pollRef.current();
        start();
      } else {
        stop();
      }
    };

    start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", stop);
    window.addEventListener("focus", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", stop);
      window.removeEventListener("focus", onVisibility);
    };
  }, []);

  if (error !== null && data === null) {
    return (
      <section className="card p-8 text-center" role="alert">
        <p className="text-sm font-medium">
          {error.code === "bas_unavailable" ? "BAS data unavailable" : "Could not load the dashboard"}
        </p>
        <p className="mt-1 text-sm text-[var(--muted)]">{error.message}</p>
      </section>
    );
  }

  if (data === null) return <DashboardSkeleton />;

  return (
    <div className="space-y-4">
      {error !== null && (
        <p className="text-xs text-red-700" role="alert">
          The last refresh failed. Showing the previous reading.
        </p>
      )}
      <DashboardCards data={data} canAdminister={canAdminister} />
    </div>
  );
}

/**
 * The cards, from a payload. Pure.
 *
 * Every project the service returned gets a card - the list is the database's,
 * never a constant. The one thing rendered that is not a card is the counting
 * guard, and it renders only when the numbers disagree.
 */
export function DashboardCards({
  data,
  canAdminister = false,
}: {
  data: BasDashboard;
  canAdminister?: boolean;
}) {
  if (data.projects.length === 0 && data.projectsInDatabase === 0) {
    return <NoProjects canAdminister={canAdminister} />;
  }

  return (
    <>
      <CountGuard rendered={data.projects.length} inDatabase={data.projectsInDatabase} />

      {/*
        About three across, wrapping as projects grow. One project today, so
        one card - and the grid is still the grid, because the second project
        must not be a layout change.
      */}
      <ul
        aria-label="Projects"
        className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3"
      >
        {data.projects.map((project) => (
          <li key={project.projectId}>
            <ProjectCard project={project} />
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * One project.
 *
 * The whole card is the link, as on Home: a card whose only target is a small
 * link at the bottom is a decoration with a button on it. The shape is the
 * module's own `.card` on the tinted ground rather than Home's filled tile -
 * Home fills in identity colour because it has one card per module; here
 * every card is the same module, and a row of three identical cyan blocks
 * would say nothing.
 */
function ProjectCard({ project }: { project: DashboardProject }) {
  // Only when there is something to have health. A project with no active
  // point shows its counts and stops: "No points at risk" over zero points
  // would be a verdict about nothing.
  const figure = project.health === null ? null : basFigure(project.health);
  const alarm = figure !== null && figure.state === "ok" && figure.alarm === true;

  /**
   * A project with no buildings is a card and not a link. Point Explorer's
   * cascade offers only projects that have a building - there is nothing to
   * narrow to otherwise - and answers `?project=` for one that has none with
   * a 404. A card that led there would be worse than one that leads nowhere;
   * the counts line already says why there is nowhere to go. A project WITH
   * a building and no JACE still links: the picker opens, empty, and says so.
   */
  const href = project.buildings > 0 ? dashboardCardHref(project.projectId) : null;
  const body = (
    <>
      <h2 className="font-display text-2xl font-semibold leading-tight tracking-tight">
        {project.name}
      </h2>

      {figure !== null && figure.state !== "unavailable" && (
        <div className="mt-4" data-testid="bas-dashboard-health">
          {/*
            The Home tile's mark: a maroon box around the words, never maroon
            words and never a maroon card. Semantic colour on a neutral card
            stays a mark, so the card itself is never read as a state.
          */}
          <p className="font-display text-lg font-semibold leading-none">
            {alarm ? (
              <span
                role="status"
                data-testid="bas-dashboard-alarm"
                className="inline-block rounded-md px-2.5 py-1"
                style={{ background: "var(--phb-maroon)", color: "#fff" }}
              >
                {figure.value}
              </span>
            ) : (
              figure.value
            )}
          </p>
          <p className="mt-2 text-xs text-[var(--muted)]">{figure.status}</p>
        </div>
      )}

      <p className="mt-4 text-xs text-[var(--muted)]" data-testid="bas-dashboard-counts">
        {describeCounts(project)}
      </p>
    </>
  );

  if (href === null) {
    return (
      <div className="card block h-full p-6" data-testid="bas-dashboard-card">
        {body}
      </div>
    );
  }

  return (
    <Link
      href={href}
      data-testid="bas-dashboard-card"
      className="card group block h-full p-6 transition-transform hover:-translate-y-0.5 focus-visible:-translate-y-0.5"
    >
      {body}
    </Link>
  );
}

/** "2 buildings · 2 JACEs", "1 building · 0 JACEs". */
export function describeCounts(project: { buildings: number; stations: number }): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return `${plural(project.buildings, "building", "buildings")} · ${plural(project.stations, "JACE", "JACEs")}`;
}

/**
 * The card count against the database, said only when they differ.
 *
 * `rendered` is what the joined card query produced; `inDatabase` is a
 * joinless count over the same scope. A join that dropped a project would
 * otherwise show fewer cards than there are projects, with nothing on screen
 * to notice it by. Red, above the cards.
 */
function CountGuard({ rendered, inDatabase }: { rendered: number; inDatabase: number }) {
  if (rendered === inDatabase) return null;
  const missing = inDatabase - rendered;
  return (
    <p
      role="alert"
      data-testid="bas-dashboard-count-mismatch"
      className="text-sm font-medium"
      style={{ color: "var(--phb-maroon)" }}
    >
      {missing > 0
        ? `${missing} ${missing === 1 ? "project is" : "projects are"} in the database but not shown here.`
        : `${rendered} cards are shown for ${inDatabase} ${inDatabase === 1 ? "project" : "projects"} in the database.`}
    </p>
  );
}

/**
 * No projects. One line, and where they come from.
 *
 * The Settings tab is offered only to a module admin, so the link is too: a
 * plain BAS user is told who adds one and is not handed a link that 404s.
 */
function NoProjects({ canAdminister }: { canAdminister: boolean }) {
  return (
    <p className="card p-8 text-center text-sm text-[var(--muted)]" data-testid="bas-dashboard-empty">
      No projects yet.{" "}
      {canAdminister ? (
        <>
          Add one under{" "}
          <Link href="/bas/settings" className="font-medium text-[var(--foreground)] underline">
            Settings
          </Link>
          .
        </>
      ) : (
        "A module administrator adds one under Settings."
      )}
    </p>
  );
}

function DashboardSkeleton() {
  return (
    <ul aria-hidden="true" className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
      <li className="card h-40 animate-pulse p-6" />
    </ul>
  );
}

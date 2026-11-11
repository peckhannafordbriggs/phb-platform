"use client";

import { ArrowLeft } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { ModuleHeader } from "@/components/module-header";
import { TabBar, type TabItem } from "@/components/ui";
import { moduleAccentStyle } from "@/lib/module-accent";
import { REPORTS_BACK_HREF, REPORTS_BAR, activeReportsItemHref } from "./reports/bar";
import { activeTabHref, tabHref, visibleBasTabs, type BasTab } from "./tabs";

/**
 * The chrome every Building Automation tab sits inside: the module heading and
 * the tab bar.
 *
 * NOT a Next.js layout, deliberately. A layout renders around a page that calls
 * `notFound()`, so an employee without the grant would get the module's heading
 * and tab bar wrapped around a 404 body - which confirms the module exists to
 * exactly the person who is not allowed to know that. Rendering the chrome from
 * inside each guarded page means there is nothing to leak.
 *
 * The tab bar is navigation. It is not authorization and it is not a security
 * boundary: every route behind it repeats the grant check independently, and so
 * does every API route those pages call.
 *
 * While the Reports tab is open the bar is the Reports bar instead
 * (2026-11-11): Back, Reports, Scheduled, Questions, Usage, drawn by the same
 * kit component in the same place. One row, never two. Back is the module's
 * default tab, so it lands on Projects with the module tabs showing again.
 */
export function BasShell({
  blurb,
  canAdminister = false,
  children,
}: {
  blurb: string;
  /**
   * Whether to offer the Settings tab. Resolved on the server by the page that
   * renders this, from `hasModuleAdmin` - never inferred in the browser.
   *
   * Defaults to false so a page that forgets to pass it hides the tab rather
   * than showing it. The wrong default here is a leak; the right one is a
   * missing link somebody reports.
   */
  canAdminister?: boolean;
  children: React.ReactNode;
}) {
  const tabs = visibleBasTabs(canAdminister);
  // usePathname needs no Suspense boundary; useSearchParams does. Which bar
  // to draw is decided here, once, for the live bar and its fallback alike.
  const pathname = usePathname() ?? "";
  const inReports = activeTabHref(pathname) === "/bas/reports";

  return (
    /*
      The accent scope wraps the whole module, not just its header. The tabs, the
      tiles and the trend line all sit outside <header>, and a chart asking for
      var(--module-accent) from out there would silently get the platform purple.

      Capped width. A dashboard stretched edge to edge on a 34-inch monitor puts
      a tile's label and its number a foot apart, and the five-across tile row
      becomes a line nobody can scan in one go.

      The tinted ground, bled to the edges of the shell's <main> so the cards sit
      ON something. The negative margins undo that padding and the positive ones
      put it back inside the tint - a panel that stopped at the content's edge
      would read as one more card.
    */
    <div
      className="dashboard-ground -mx-8 -my-8 px-8 py-8"
      style={moduleAccentStyle(BAS_MODULE_KEY)}
    >
      <div className="mx-auto max-w-[104rem]">
        <ModuleHeader moduleKey={BAS_MODULE_KEY} title="Building Automation" blurb={blurb}>
          {/*
            useSearchParams needs a Suspense boundary to be renderable in any
            context. The fallback is the same bar without the carried query string,
            so a tab is never missing while it resolves - it just briefly forgets
            the filters, which is a link that still goes to the right screen.
          */}
          <Suspense fallback={<Tabs carryQuery={false} tabs={tabs} pathname={pathname} inReports={inReports} />}>
            <Tabs carryQuery tabs={tabs} pathname={pathname} inReports={inReports} />
          </Suspense>
        </ModuleHeader>

        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

function Tabs({
  carryQuery,
  tabs,
  pathname,
  inReports,
}: {
  carryQuery: boolean;
  tabs: readonly BasTab[];
  pathname: string;
  inReports: boolean;
}) {
  return carryQuery ? (
    <LiveTabs tabs={tabs} pathname={pathname} inReports={inReports} />
  ) : (
    <StaticTabs tabs={tabs} pathname={pathname} inReports={inReports} />
  );
}

function LiveTabs({ tabs, pathname, inReports }: { tabs: readonly BasTab[]; pathname: string; inReports: boolean }) {
  const searchParams = useSearchParams();
  const hrefFor = (href: string) => tabHref(href, searchParams);

  return inReports ? (
    <ReportsBar active={activeReportsItemHref(pathname)} hrefFor={hrefFor} />
  ) : (
    <Bar tabs={tabs} active={activeTabHref(pathname)} hrefFor={hrefFor} />
  );
}

function StaticTabs({ tabs, pathname, inReports }: { tabs: readonly BasTab[]; pathname: string; inReports: boolean }) {
  const hrefFor = (href: string) => href;

  return inReports ? (
    <ReportsBar active={activeReportsItemHref(pathname)} hrefFor={hrefFor} />
  ) : (
    <Bar tabs={tabs} active={null} hrefFor={hrefFor} />
  );
}

/**
 * The shared kit's tab bar (components/ui/TabBar, 2026-11-10). Which tab is
 * active is decided here, by longest prefix, and the query string is carried
 * across; the bar only draws. The active tab's underline is the module's own
 * colour, the same cyan as its diamond in the sidebar and its header rule -
 * unless the tab names its own accent (Analyze: purple).
 */
function Bar({
  tabs,
  active,
  hrefFor,
}: {
  tabs: readonly BasTab[];
  active: string | null;
  hrefFor: (href: string) => string;
}) {
  return (
    <TabBar
      label="Building Automation sections"
      tabs={tabs.map((tab) => ({
        href: hrefFor(tab.href),
        label: tab.label,
        active: tab.href === active,
        accent: tab.accent,
      }))}
    />
  );
}

/**
 * The Reports bar: the same kit component, the Reports-only items, and Back
 * at the far left - an arrow and the word, a quiet tab-shaped item that is
 * never active, going to the module's default tab. The query string is
 * carried the way the module bar carries it, so a building filter survives
 * the trip out and back.
 */
function ReportsBar({ active, hrefFor }: { active: string | null; hrefFor: (href: string) => string }) {
  const back: TabItem = {
    href: hrefFor(REPORTS_BACK_HREF),
    label: (
      <>
        <ArrowLeft size={14} aria-hidden="true" />
        <span>Back</span>
      </>
    ),
    active: false,
  };
  const items: TabItem[] = REPORTS_BAR.map((item) => ({
    href: hrefFor(item.href),
    label: item.label,
    active: item.href === active,
  }));

  return <TabBar label="Reports sections" tabs={[back, ...items]} />;
}

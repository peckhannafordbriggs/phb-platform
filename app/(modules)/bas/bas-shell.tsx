"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { ModuleHeader } from "@/components/module-header";
import { TabBar } from "@/components/ui";
import { moduleAccentStyle } from "@/lib/module-accent";
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
          <Suspense fallback={<Tabs carryQuery={false} tabs={tabs} />}>
            <Tabs carryQuery tabs={tabs} />
          </Suspense>
        </ModuleHeader>

        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

function Tabs({ carryQuery, tabs }: { carryQuery: boolean; tabs: readonly BasTab[] }) {
  return carryQuery ? <LiveTabs tabs={tabs} /> : <StaticTabs tabs={tabs} />;
}

function LiveTabs({ tabs }: { tabs: readonly BasTab[] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = activeTabHref(pathname);

  return <Bar tabs={tabs} active={active} hrefFor={(href) => tabHref(href, searchParams)} />;
}

function StaticTabs({ tabs }: { tabs: readonly BasTab[] }) {
  return <Bar tabs={tabs} active={null} hrefFor={(href) => href} />;
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

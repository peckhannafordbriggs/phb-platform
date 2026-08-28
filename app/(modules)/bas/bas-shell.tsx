"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { ModuleHeader } from "@/components/module-header";
import { moduleAccentStyle } from "@/lib/module-accent";
import { BAS_TABS, activeTabHref, tabHref } from "./tabs";

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
  children,
}: {
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    /*
      The accent scope wraps the whole module, not just its header. The tabs, the
      tiles and the trend line all sit outside <header>, and a chart asking for
      var(--module-accent) from out there would silently get the platform purple.
    */
    <div style={moduleAccentStyle(BAS_MODULE_KEY)}>
      <ModuleHeader moduleKey={BAS_MODULE_KEY} title="Building Automation" blurb={blurb}>
        {/*
          useSearchParams needs a Suspense boundary to be renderable in any
          context. The fallback is the same bar without the carried query string,
          so a tab is never missing while it resolves - it just briefly forgets
          the filters, which is a link that still goes to the right screen.
        */}
        <Suspense fallback={<TabBar carryQuery={false} />}>
          <TabBar carryQuery />
        </Suspense>
      </ModuleHeader>

      <div className="mt-6">{children}</div>
    </div>
  );
}

function TabBar({ carryQuery }: { carryQuery: boolean }) {
  return carryQuery ? <LiveTabBar /> : <StaticTabBar />;
}

function LiveTabBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = activeTabHref(pathname);

  return (
    <Tabs
      active={active}
      hrefFor={(href) => tabHref(href, searchParams)}
    />
  );
}

function StaticTabBar() {
  return <Tabs active={null} hrefFor={(href) => href} />;
}

/**
 * A bottom-border underline on the active tab, and nothing else.
 *
 * No animated indicator, no sliding underline. docs/01: professional internal
 * software, clarity over decoration. The pattern is GitHub's repo nav, which
 * people already know how to read.
 */
function Tabs({
  active,
  hrefFor,
}: {
  active: string | null;
  hrefFor: (href: string) => string;
}) {
  return (
    <nav
      aria-label="Building Automation sections"
      className="mt-3 border-b border-[var(--border)]"
    >
      <ul className="-mb-px flex gap-1">
        {BAS_TABS.map((tab) => {
          const isActive = tab.href === active;
          return (
            <li key={tab.href}>
              <Link
                href={hrefFor(tab.href)}
                aria-current={isActive ? "page" : undefined}
                className={
                  "inline-block border-b-2 px-3 py-2 text-[0.8125rem] transition-colors " +
                  (isActive
                    ? "font-medium text-[var(--foreground)]"
                    : "border-transparent text-[var(--muted)] hover:border-[var(--neutral-300)] hover:text-[var(--foreground)]")
                }
                // The active tab's underline is the module's own colour, the
                // same cyan as its diamond in the sidebar and its header rule.
                style={
                  isActive
                    ? { borderColor: "var(--module-accent, var(--phb-cyan))" }
                    : undefined
                }
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

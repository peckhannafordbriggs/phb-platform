"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { REPORT_SUBTABS, activeSubTabHref } from "./reports/subtabs";

/**
 * The Reports tab's chrome: a second, smaller tab bar under the module's,
 * then the sub-tab's content. Rendered INSIDE each guarded page, like
 * BasShell, and for the same reason - a layout would wrap a 404.
 *
 * `pathname` can be passed so a node-environment test can render the bar
 * without a router; the pages leave it undefined and the hook decides.
 */
export function ReportsShell({
  children,
  pathname,
}: {
  children: React.ReactNode;
  pathname?: string;
}) {
  return (
    <div>
      <SubTabs pathname={pathname} />
      <div className="mt-5">{children}</div>
    </div>
  );
}

function SubTabs({ pathname }: { pathname?: string }) {
  const livePathname = usePathname();
  const active = activeSubTabHref(pathname ?? livePathname ?? "");

  return (
    <nav aria-label="Reports sections" className="border-b border-[var(--divider-soft)]">
      <ul className="-mb-px flex gap-1">
        {REPORT_SUBTABS.map((tab) => {
          const isActive = tab.href === active;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={isActive ? "page" : undefined}
                className={
                  "inline-block border-b-2 px-3 py-1.5 text-[0.8125rem] transition-colors " +
                  (isActive
                    ? "font-medium text-[var(--foreground)]"
                    : "border-transparent text-[var(--muted)] hover:border-[var(--neutral-300)] hover:text-[var(--foreground)]")
                }
                style={isActive ? { borderColor: "var(--module-accent, var(--phb-cyan))" } : undefined}
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

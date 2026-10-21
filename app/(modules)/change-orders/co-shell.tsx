"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { CHANGE_ORDERS_MODULE_KEY } from "@/lib/modules/change-orders/constants";
import { ModuleHeader } from "@/components/module-header";
import { fetchReviewCount } from "./review-client";
import { CO_TABS, REVIEW_TAB_HREF, activeTabHref } from "./tabs";

/**
 * The chrome every Change Orders tab sits inside: the module heading and the
 * tab bar - the BAS pattern (bas-shell.tsx), for the same reasons.
 *
 * NOT a Next.js layout, deliberately. A layout renders around a page that
 * calls `notFound()`, so an employee without the grant would get the heading
 * and tab bar wrapped around a 404 body. Rendered from inside each guarded
 * page instead, so there is nothing to leak.
 *
 * The tab bar is navigation, not authorization: every page behind it and
 * every API route those pages call repeats the grant check.
 */
export function CoShell({
  blurb,
  children,
}: {
  blurb: string;
  children?: React.ReactNode;
}) {
  return (
    <>
      <ModuleHeader moduleKey={CHANGE_ORDERS_MODULE_KEY} title="Change Orders" blurb={blurb}>
        <TabBar />
      </ModuleHeader>
      {children}
    </>
  );
}

/**
 * How often the count on the Needs Review tab is re-read while a Change
 * Orders screen is visible. The same 20 seconds as the mailbox poll, and for
 * the same reason: a new note reaches the folder within a minute of the
 * classifier writing it, and a count that lags by a day is a count people
 * learn to ignore. One folder listing per poll, no note read.
 */
const COUNT_POLL_MS = 20_000;

/**
 * The live count, or null while unknown.
 *
 * Null covers loading, "not configured" and any failure alike: the tab then
 * reads plainly "Needs Review", and the tab's own page says why. A number that
 * might be stale is worse than no number, so a failed refresh clears it rather
 * than keeping the last one.
 *
 * Runs only while the document is visible - a background tab polls nothing.
 */
function useReviewCount(): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;

    const load = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      controller?.abort();
      controller = new AbortController();
      try {
        const summary = await fetchReviewCount(controller.signal);
        if (!cancelled) setCount(summary.count);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!cancelled) setCount(null);
      }
    };

    void load();
    const timer = setInterval(() => void load(), COUNT_POLL_MS);
    const onVisible = () => void load();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return count;
}

/**
 * A bottom-border underline on the active tab, and nothing else - the same
 * markup as the BAS tab bar. The Needs Review label carries the live count in
 * parentheses, as decided: "Needs Review (5)".
 */
function TabBar() {
  const pathname = usePathname();
  const active = activeTabHref(pathname);
  const count = useReviewCount();

  return (
    <nav aria-label="Change Orders sections" className="mt-3 border-b border-[var(--border)]">
      <ul className="-mb-px flex gap-1">
        {CO_TABS.map((tab) => {
          const isActive = tab.href === active;
          const label =
            tab.href === REVIEW_TAB_HREF && count !== null
              ? `${tab.label} (${count})`
              : tab.label;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={isActive ? "page" : undefined}
                className={
                  "inline-block border-b-2 px-3 py-2 text-[0.8125rem] transition-colors " +
                  (isActive
                    ? "font-medium text-[var(--foreground)]"
                    : "border-transparent text-[var(--muted)] hover:border-[var(--neutral-300)] hover:text-[var(--foreground)]")
                }
                style={isActive ? { borderColor: "var(--module-accent)" } : undefined}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

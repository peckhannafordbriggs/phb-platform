import Link from "next/link";
import { LinkPending } from "./LinkPending";

export interface TabItem {
  /** A real route. Bookmarkable, refreshable, middle-clickable. */
  href: string;
  label: React.ReactNode;
  active: boolean;
}

/**
 * The underlined tab bar under a module header - the pattern every module
 * draws (BAS, Cost Intelligence, Freeze Protection, Change Orders), with the
 * active tab's underline in the module's own colour.
 *
 * Which tab is active is the caller's decision, because each module has its
 * own rule for it (longest prefix, an exact match, a query string carried
 * along). The bar only draws. `actions` is whatever the caller puts on the
 * right - search, a New button - and the bar knows nothing about it.
 */
export function TabBar({
  label,
  tabs,
  actions,
}: {
  /** The nav's accessible name, e.g. "Change Orders sections". */
  label: string;
  tabs: readonly TabItem[];
  actions?: React.ReactNode;
}) {
  return (
    <nav aria-label={label} className="mt-3 flex items-center justify-between">
      <ul className="-mb-px flex gap-1 border-b border-[var(--border)]">
        {tabs.map((tab) => (
          <li key={tab.href}>
            <Link
              href={tab.href}
              aria-current={tab.active ? "page" : undefined}
              className={
                "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[0.8125rem] transition-colors " +
                (tab.active
                  ? "font-medium text-[var(--foreground)]"
                  : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]")
              }
              style={tab.active ? { borderColor: "var(--module-accent)" } : undefined}
            >
              {tab.label}
              <LinkPending />
            </Link>
          </li>
        ))}
      </ul>
      {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
    </nav>
  );
}

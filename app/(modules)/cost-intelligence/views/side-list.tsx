"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { RefreshCw, Search } from "lucide-react";
import { Button } from "../ui/Button";
import { LinkPending } from "../ui/LinkPending";
import { Pill } from "../ui/Pill";

/**
 * The pieces every Settings list shares: the left-hand list (skills, workflows,
 * projects), the Sync button, and the last-sync line under it.
 */

export type SideListItem = {
  id: string;
  href: string;
  label: string;
  /** Small text on the right: a version, a date. */
  meta?: string;
  mono?: boolean;
  /** Instead of `meta`, e.g. a status pill. */
  badge?: React.ReactNode;
};

/**
 * One compact row per item, each its own URL. `scroll={false}` keeps the page
 * still and the selected row is scrolled back into view after the page
 * re-renders. `filterLabel` adds a filter box above the rows.
 */
export function SideList({
  items,
  selected,
  empty,
  filterLabel,
}: {
  items: SideListItem[];
  selected: string | null;
  empty: string;
  filterLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const selectedRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items;

  return (
    <>
      {filterLabel && (
        <div className="shrink-0 px-3 pt-3">
          <div className="flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3 focus-within:border-[var(--module-accent)]">
            <Search size={14} aria-hidden="true" className="shrink-0 text-[var(--muted)]" />
            <input
              type="search"
              aria-label={filterLabel}
              placeholder={filterLabel}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full bg-transparent text-[0.8125rem] outline-none"
            />
          </div>
        </div>
      )}
      {shown.length === 0 ? (
        <p className="px-5 py-6 text-[0.8125rem] text-[var(--muted)]">{items.length === 0 ? empty : "No match."}</p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {shown.map((item) => {
            const isSelected = item.id === selected;
            return (
              <li key={item.id}>
                <Link
                  ref={isSelected ? selectedRef : undefined}
                  href={item.href}
                  scroll={false}
                  aria-current={isSelected ? "page" : undefined}
                  className={
                    "flex items-center justify-between gap-3 rounded-[var(--radius-control)] px-3 py-1.5 text-[0.8125rem] transition-colors " +
                    (isSelected
                      ? "bg-[color-mix(in_srgb,var(--module-accent)_16%,transparent)] font-semibold text-[var(--module-accent-ink)]"
                      : "text-[var(--foreground)] hover:bg-[var(--neutral-100)]")
                  }
                >
                  <span className="truncate">{item.label}</span>
                  <LinkPending>
                    {item.badge ??
                      (item.meta && (
                        <span
                          className={
                            "shrink-0 text-[0.6875rem] text-[var(--muted)] " + (item.mono ? "font-mono" : "")
                          }
                        >
                          {item.meta}
                        </span>
                      ))}
                  </LinkPending>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/**
 * Runs a sync, then refreshes the page so the list and the status line update.
 * Says "Syncing…" until the refreshed page is on screen, not just until the
 * request returns.
 * Only a request that never produced a sync row (409, network) shows a message
 * here, floated under the button so the header never reflows; every other
 * outcome is in the status line.
 */
export function SyncButton({ url }: { url: string }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const busy = syncing || refreshing;

  async function sync() {
    setSyncing(true);
    setError(null);
    try {
      const response = await fetch(url, { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message: string } } | null;
        setError(body?.error?.message ?? "Sync failed. Try again.");
      }
      startRefresh(() => router.refresh());
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="relative shrink-0">
      <Button onClick={sync} disabled={busy}>
        <RefreshCw size={14} aria-hidden="true" className={busy ? "animate-spin" : undefined} />
        {busy ? "Syncing…" : "Sync"}
      </Button>
      {error && (
        <p role="alert" className="absolute right-0 top-full z-10 mt-1 w-56 rounded-md bg-white p-2 text-[0.75rem] shadow-md">
          {error}
        </p>
      )}
    </div>
  );
}

/** The fields of a `cip_skill_syncs` or `cip_project_syncs` row the status line needs. */
export type SyncSummary = {
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  errors: unknown;
  added: number;
  updated: number;
  removed: number;
};

const MOMENT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
});

/** "Last synced Oct 12, 2:00 PM · 1 added, 0 updated, 0 removed", or why it failed. */
export function SyncStatus({ sync }: { sync: SyncSummary | null }) {
  if (sync === null) return <p className="mt-2 text-[0.75rem] text-[var(--muted)]">Never synced.</p>;
  if (sync.status === "running") return <p className="mt-2 text-[0.75rem] text-[var(--muted)]">Sync in progress…</p>;

  const when = MOMENT.format(sync.finishedAt ?? sync.startedAt);
  const errors = Array.isArray(sync.errors) ? (sync.errors as unknown[]) : [];

  if (sync.status === "failed") {
    const first = errors[0];
    const reason =
      first !== null && typeof first === "object" && "reason" in first && typeof first.reason === "string"
        ? first.reason
        : null;
    return (
      <div className="mt-2 flex flex-col gap-1 text-[0.75rem]">
        <span>
          <Pill tone="warn">Sync failed</Pill> <span className="text-[var(--muted)]">{when}</span>
        </span>
        {reason && <span className="text-[var(--muted)]">{reason}</span>}
      </div>
    );
  }

  return (
    <p className="mt-2 text-[0.75rem] text-[var(--muted)]">
      Last synced {when} · {sync.added} added, {sync.updated} updated, {sync.removed} removed
      {sync.status === "partial" && (
        <>
          {" "}
          <Pill tone="warn">{errors.length} could not be read</Pill>
        </>
      )}
    </p>
  );
}

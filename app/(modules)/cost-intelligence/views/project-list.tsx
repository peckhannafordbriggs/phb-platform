"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

export type ProjectListItem = { id: string; folderName: string; lastModified: Date | null };

const CHANGED = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

/**
 * The projects list with a filter box. Each project is its own URL, like
 * skills: `scroll={false}` keeps the page still and the selected row is
 * scrolled back into view after the page re-renders.
 */
export function ProjectList({ projects, selected }: { projects: ProjectListItem[]; selected: string | null }) {
  const [query, setQuery] = useState("");
  const selectedRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const q = query.trim().toLowerCase();
  const shown = q ? projects.filter((p) => p.folderName.toLowerCase().includes(q)) : projects;

  return (
    <>
      <div className="shrink-0 px-3 pt-3">
        <div className="flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3 focus-within:border-[var(--module-accent)]">
          <Search size={14} aria-hidden="true" className="shrink-0 text-[var(--muted)]" />
          <input
            type="search"
            aria-label="Filter projects"
            placeholder="Filter projects"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-transparent text-[0.8125rem] outline-none"
          />
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="px-5 py-6 text-[0.8125rem] text-[var(--muted)]">
          {projects.length === 0 ? "No projects yet. Press Sync to read the BID-DOC folder." : "No project matches."}
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {shown.map((p) => {
            const isSelected = p.id === selected;
            return (
              <li key={p.id}>
                <Link
                  ref={isSelected ? selectedRef : undefined}
                  href={`/cost-intelligence/settings/projects/${p.id}`}
                  scroll={false}
                  aria-current={isSelected ? "page" : undefined}
                  className={
                    "flex items-center justify-between gap-3 rounded-[var(--radius-control)] px-3 py-1.5 text-[0.8125rem] transition-colors " +
                    (isSelected
                      ? "bg-[color-mix(in_srgb,var(--module-accent)_16%,transparent)] font-semibold text-[var(--module-accent-ink)]"
                      : "text-[var(--foreground)] hover:bg-[var(--neutral-100)]")
                  }
                >
                  <span className="truncate">{p.folderName}</span>
                  <span className="shrink-0 text-[0.6875rem] text-[var(--muted)]">
                    {p.lastModified ? CHANGED.format(p.lastModified) : "Empty"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

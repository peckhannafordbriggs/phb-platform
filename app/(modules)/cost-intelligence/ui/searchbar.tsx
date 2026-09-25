"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

/**
 * TODO(backend): replace with a call to the Cost Intelligence search route,
 * e.g. `GET /api/modules/cost-intelligence/search?q=`. Honour `signal` so a
 * superseded query is cancelled rather than racing the newer one.
 */
async function searchCostIntelligence(query: string, signal: AbortSignal): Promise<[]> {
  void query;
  void signal;
  return [];
}


export function SearchBar({ placeholder = "Search runs, projects, skills" }: { placeholder?: string }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const router = useRouter();

  const trimmed = query.trim();

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      if (query){
        searchCostIntelligence(trimmed, new AbortController().signal);
      }
    }
  }

  return (
    <div ref={rootRef} className="relative w-64">
      <div className="flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3 focus-within:border-[var(--module-accent)]">
        <Search size={14} aria-hidden="true" className="shrink-0 text-[var(--muted)]" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-label="Search Cost Intelligence"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          value={query}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-[var(--foreground)] outline-none placeholder:text-[var(--muted)] [&::-webkit-search-cancel-button]:hidden"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            className="rounded p-0.5 text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <X size={12} aria-hidden="true" />
          </button>
        ) : (
          <kbd className="rounded border border-[var(--border)] px-1.5 text-[0.6875rem] leading-4 text-[var(--muted)]">/</kbd>
        )}
      </div>
    </div>
  );
}

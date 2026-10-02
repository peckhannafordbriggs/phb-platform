"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { PLACEHOLDER_RUNS } from "@/lib/modules/cost-intelligence/placeholder";
import { PLACEHOLDER_SKILLS } from "@/lib/modules/cost-intelligence/placeholder-settings";

type Result = { href: string; kind: string; label: string; detail: string };

/** TODO(backend): replace with `GET /api/modules/cost-intelligence/search?q=`. Skills are admin only. */
function search(query: string, canAdminister: boolean): Result[] {
  const all: Result[] = [
    ...PLACEHOLDER_RUNS.map((r) => ({
      href: `/cost-intelligence/runs/${r.id}`,
      kind: "Run",
      label: `${r.workflow} · ${r.project}`,
      detail: r.status,
    })),
    ...(canAdminister
      ? PLACEHOLDER_SKILLS.map((s) => ({ href: `/cost-intelligence/settings/skills/${s.id}`, kind: "Skill", label: s.name, detail: s.id }))
      : []),
  ];
  const q = query.toLowerCase();
  return all.filter((r) => `${r.label} ${r.detail}`.toLowerCase().includes(q)).slice(0, 8);
}

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

/** Live search over runs and (for admins) skills. "/" anywhere focuses it. */
export function SearchBar({
  placeholder = "Search runs and skills",
  canAdminister = false,
}: {
  placeholder?: string;
  canAdminister?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const router = useRouter();

  const trimmed = query.trim();
  const results = trimmed ? search(trimmed, canAdminister) : [];
  const shown = open && trimmed !== "";

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "/" && !isTyping(e.target)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    function onPointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, []);

  function close() {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = Math.max(results.length, 1);
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Enter" && results[active]) {
      router.push(results[active].href);
      close();
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
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
          aria-expanded={shown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown && results[active] ? `${listId}-${active}` : undefined}
          value={query}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
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
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            className="rounded p-0.5 text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <X size={12} aria-hidden="true" />
          </button>
        ) : (
          <kbd className="rounded border border-[var(--border)] px-1.5 text-[0.6875rem] leading-4 text-[var(--muted)]">/</kbd>
        )}
      </div>

      {shown && (
        <ul
          id={listId}
          role="listbox"
          className="absolute right-0 top-full z-20 mt-1 w-96 rounded-[var(--radius-control)] border border-[var(--border)] bg-white p-1 shadow-lg"
        >
          {results.length === 0 ? (
            <li className="px-3 py-2 text-[0.8125rem] text-[var(--muted)]">No matches</li>
          ) : (
            results.map((r, i) => (
              <li key={r.href} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
                <Link
                  href={r.href}
                  onClick={close}
                  onMouseEnter={() => setActive(i)}
                  className={
                    "flex items-center gap-3 rounded-[var(--radius-row)] px-3 py-2 text-[0.8125rem] " +
                    (i === active ? "bg-[var(--neutral-50)]" : "")
                  }
                >
                  <span className="eyebrow w-10 shrink-0 text-[var(--muted)]">{r.kind}</span>
                  <span className="min-w-0 flex-1 truncate">{r.label}</span>
                  <span className="max-w-28 shrink-0 truncate text-[0.75rem] text-[var(--muted)]">{r.detail}</span>
                </Link>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

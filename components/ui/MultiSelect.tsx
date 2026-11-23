"use client";

import { Check, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export type MultiSelectOption = {
  value: string;
  label: string;
  /** Muted text after the label in the open list only - a type, a count. */
  hint?: string;
};

/**
 * A searchable multi-select with a chip per selection (2026-11-20, first for
 * Point Explorer's Equipment).
 *
 * The box holds the chips - one per chosen option, each with its own remove
 * button - and a toggle that opens the list. The list has a search box, which
 * takes focus when it opens; "Select all" and "Clear", which act on the
 * options the search is showing; and a checkbox row per option. In the
 * search box the arrow keys move, Enter ticks or unticks, and Escape closes;
 * a click outside closes it too. Past `chipLimit` chosen options the chips
 * stop at "+N more", which opens the list - sixty chips is a list, not a
 * control.
 *
 * Controlled only: the caller holds `value`, in whatever order it likes; the
 * chips follow the options' order so they do not reshuffle as you tick.
 */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
  placeholder = "None selected",
  searchPlaceholder = "Search",
  chipLimit = 8,
  disabled = false,
  className = "",
  testId,
}: {
  /** The accessible name of the toggle and the list. */
  label: string;
  options: MultiSelectOption[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  /** What the box says with nothing chosen. */
  placeholder?: string;
  searchPlaceholder?: string;
  chipLimit?: number;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const chosen = new Set(value);
  const term = query.trim().toLowerCase();
  const shown = term.length === 0 ? options : options.filter((o) => o.label.toLowerCase().includes(term) || (o.hint ?? "").toLowerCase().includes(term));
  const chips = options.filter((o) => chosen.has(o.value));

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    function onDown(e: MouseEvent) {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function toggle(option: MultiSelectOption) {
    onChange(chosen.has(option.value) ? value.filter((v) => v !== option.value) : [...value, option.value]);
  }

  function selectShown() {
    const next = [...value];
    for (const o of shown) if (!chosen.has(o.value)) next.push(o.value);
    onChange(next);
  }

  function clearShown() {
    const drop = new Set(shown.map((o) => o.value));
    onChange(value.filter((v) => !drop.has(v)));
  }

  function close() {
    setOpen(false);
    toggleRef.current?.focus();
  }

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length === 0) return;
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = shown[active];
      if (option !== undefined) toggle(option);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  const summary = chips.length === 0 ? placeholder : `${chips.length} selected`;

  return (
    <div ref={rootRef} className={"relative " + className} data-testid={testId}>
      <div
        className={
          "flex min-h-10 flex-wrap items-center gap-1 rounded-[var(--radius-control)] border border-[var(--border)] bg-white py-1 pl-1.5 pr-8 focus-within:border-[var(--neutral-500)] " +
          (disabled ? "opacity-50" : "")
        }
      >
        {chips.slice(0, chipLimit).map((o) => (
          <span
            key={o.value}
            className="inline-flex h-7 max-w-[14rem] items-center gap-1 rounded-full bg-[var(--neutral-100)] pl-2.5 pr-1 text-xs text-[var(--foreground)]"
            data-testid="multiselect-chip"
          >
            <span className="truncate">{o.label}</span>
            <button
              type="button"
              aria-label={`Remove ${o.label}`}
              disabled={disabled}
              onClick={() => onChange(value.filter((v) => v !== o.value))}
              className="rounded-full p-0.5 text-[var(--muted)] hover:bg-[var(--neutral-200)] hover:text-[var(--foreground)]"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        {chips.length > chipLimit && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex h-7 items-center rounded-full border border-[var(--border)] px-2.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
            data-testid="multiselect-more"
          >
            +{chips.length - chipLimit} more
          </button>
        )}
        <button
          ref={toggleRef}
          type="button"
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && !open) {
              e.preventDefault();
              setOpen(true);
            }
          }}
          className={
            "h-8 min-w-24 flex-1 truncate px-1.5 text-left text-[0.8125rem] focus-visible:outline-none! " +
            (chips.length === 0 ? "text-[var(--muted)]" : "text-xs text-[var(--muted)]")
          }
        >
          {summary}
        </button>
      </div>
      <ChevronDown
        size={14}
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-5 -translate-y-1/2 text-[var(--muted)]"
      />

      {open && (
        <div className="absolute left-0 z-20 mt-1 w-full min-w-72 rounded-[var(--radius-control)] border border-[var(--border)] bg-white p-1 shadow-lg">
          <div className="flex h-9 items-center gap-2 rounded-[calc(var(--radius-control)-2px)] border border-[var(--border)] px-2.5 focus-within:border-[var(--module-accent)]">
            <Search size={14} aria-hidden="true" className="shrink-0 text-[var(--muted)]" />
            <input
              ref={searchRef}
              type="search"
              aria-label={searchPlaceholder}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKey}
              aria-controls={listId}
              aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
              className="min-w-0 flex-1 bg-transparent text-[0.8125rem] outline-none placeholder:text-[var(--muted)] [&::-webkit-search-cancel-button]:hidden"
            />
          </div>
          <div className="flex items-center gap-3 px-2 pb-1 pt-1.5 text-xs">
            <button type="button" onClick={selectShown} disabled={shown.length === 0} className="font-medium text-[var(--foreground)] hover:underline disabled:opacity-50">
              {term.length === 0 ? "Select all" : `Select all ${shown.length} shown`}
            </button>
            <button type="button" onClick={clearShown} disabled={chips.length === 0} className="text-[var(--muted)] hover:text-[var(--foreground)] hover:underline disabled:opacity-50">
              Clear
            </button>
            <span className="ml-auto text-[var(--muted)]">{chips.length} of {options.length} selected</span>
          </div>
          {shown.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-[var(--muted)]">Nothing matches.</p>
          ) : (
            <ul
              id={listId}
              role="listbox"
              aria-label={label}
              aria-multiselectable="true"
              className="max-h-64 overflow-y-auto"
            >
              {shown.map((o, i) => {
                const on = chosen.has(o.value);
                return (
                  <li
                    key={o.value}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={on}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => toggle(o)}
                    className={
                      "flex cursor-pointer items-center gap-2 rounded-[calc(var(--radius-control)-2px)] px-2.5 py-2 text-[0.8125rem] text-[var(--foreground)] " +
                      (i === active ? "bg-[var(--neutral-50)]" : "")
                    }
                  >
                    <span
                      aria-hidden="true"
                      className={
                        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border " +
                        (on ? "border-[var(--foreground)] bg-[var(--foreground)] text-white" : "border-[var(--neutral-400)] bg-white")
                      }
                    >
                      {on && <Check size={11} strokeWidth={3} />}
                    </span>
                    <span className="truncate">{o.label}</span>
                    {o.hint ? <span className="ml-auto shrink-0 pl-2 text-[0.6875rem] text-[var(--muted)]">{o.hint}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

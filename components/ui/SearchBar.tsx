"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type RefObject } from "react";

export type SearchResult = { href: string; kind: string; label: string; detail: string };

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

interface Common {
  /** The accessible name, e.g. "Search Cost Intelligence". */
  label: string;
  placeholder: string;
  /** Whether "/" focuses this box. */
  hotkey?: boolean;
  className?: string;
}

/**
 * The kit's search box, in one of two modes.
 *
 * With `search`, a live search with a result list: arrows and Enter open a
 * result, Escape closes. What it searches is the caller's function - the bar
 * holds no data of its own. Promoted from Cost Intelligence, which supplies
 * its runs-and-skills lookup.
 *
 * With `value` and `onChange` instead, a filter over a list the caller
 * renders: the same box, the same clear button, no result list (2026-11-10,
 * for the BAS Settings tree and its Points list). A filter box needs no
 * router, so it renders anywhere - a node test included. In both modes "/"
 * anywhere focuses the box unless `hotkey` is false - two boxes on one
 * screen cannot both own the key.
 */
export function SearchBar(
  props: Common &
    (
      | { search: (query: string) => SearchResult[]; value?: undefined; onChange?: undefined }
      | { search?: undefined; value: string; onChange: (value: string) => void }
    ),
) {
  if (props.search !== undefined) return <LiveSearch {...props} search={props.search} />;
  return <FilterBox {...props} value={props.value ?? ""} onChange={props.onChange ?? (() => undefined)} />;
}

/** The box itself: the icon, the input, and either the clear button or the "/" hint. */
function Box({
  inputRef,
  rootRef,
  className,
  text,
  onClear,
  hotkey,
  input,
  children,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  rootRef: RefObject<HTMLDivElement | null>;
  className: string;
  text: string;
  onClear: () => void;
  hotkey: boolean;
  input: React.InputHTMLAttributes<HTMLInputElement>;
  children?: React.ReactNode;
}) {
  return (
    <div ref={rootRef} className={"relative " + (className.length > 0 ? className : "w-64")}>
      <div className="flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3 focus-within:border-[var(--module-accent)]">
        <Search size={14} aria-hidden="true" className="shrink-0 text-[var(--muted)]" />
        <input
          ref={inputRef}
          type="search"
          {...input}
          className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-[var(--foreground)] outline-none placeholder:text-[var(--muted)] [&::-webkit-search-cancel-button]:hidden"
        />
        {text ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={onClear}
            className="rounded p-0.5 text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <X size={12} aria-hidden="true" />
          </button>
        ) : hotkey ? (
          <kbd className="rounded border border-[var(--border)] px-1.5 text-[0.6875rem] leading-4 text-[var(--muted)]">/</kbd>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function useSlashHotkey(enabled: boolean, inputRef: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "/" && !isTyping(e.target)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, inputRef]);
}

function FilterBox({
  label,
  placeholder,
  value,
  onChange,
  hotkey = true,
  className = "",
}: Common & { value: string; onChange: (value: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useSlashHotkey(hotkey, inputRef);

  return (
    <Box
      inputRef={inputRef}
      rootRef={rootRef}
      className={className}
      text={value}
      hotkey={hotkey}
      onClear={() => {
        onChange("");
        inputRef.current?.focus();
      }}
      input={{
        "aria-label": label,
        value,
        placeholder,
        onChange: (e) => onChange(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Escape") inputRef.current?.blur();
        },
      }}
    />
  );
}

function LiveSearch({
  label,
  placeholder,
  search,
  hotkey = true,
  className = "",
}: Common & { search: (query: string) => SearchResult[] }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const router = useRouter();

  const trimmed = query.trim();
  const results = trimmed ? search(trimmed) : [];
  const shown = open && trimmed !== "";

  useSlashHotkey(hotkey, inputRef);

  useEffect(() => {
    function onPointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
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
    <Box
      inputRef={inputRef}
      rootRef={rootRef}
      className={className}
      text={query}
      hotkey={hotkey}
      onClear={() => {
        setQuery("");
        inputRef.current?.focus();
      }}
      input={{
        role: "combobox",
        "aria-label": label,
        "aria-expanded": shown,
        "aria-controls": listId,
        "aria-autocomplete": "list",
        "aria-activedescendant": shown && results[active] ? `${listId}-${active}` : undefined,
        value: query,
        placeholder,
        onChange: (e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        },
        onFocus: () => setOpen(true),
        onKeyDown,
      }}
    >
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
    </Box>
  );
}

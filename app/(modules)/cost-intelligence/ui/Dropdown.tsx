"use client";

import { useState } from "react";

export type DropdownOption = { value: string; label: string };

export function Dropdown({
  options,
  placeholder,
  value,
  onChange,
  label,
  className = "",
}: {
  options: DropdownOption[];
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
  label: string;
  className?: string;
}) {
  const [internal, setInternal] = useState("");
  const [open, setOpen] = useState(false);

  const current = value ?? internal;
  const selected = options.find((o) => o.value === current);

  function choose(option: DropdownOption) {
    if (value === undefined) setInternal(option.value);
    onChange?.(option.value);
    setOpen(false);
  }

  return (
    <div className={"relative " + className}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onBlur={() => setOpen(false)}
        className={
          "flex h-10 w-full items-center rounded-[var(--radius-control)] border border-[var(--border)] bg-white pl-3 pr-9 text-left text-[0.8125rem] focus-visible:rounded-[var(--radius-control)]! focus-visible:border-[var(--neutral-500)] focus-visible:outline-none! " +
          (selected ? "text-[var(--foreground)]" : "text-[var(--muted)]")
        }
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
      </button>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>

      {open && (
        <ul className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-[var(--radius-control)] border border-[var(--border)] bg-white p-1 shadow-lg">
          {options.map((o) => (
            <li
              key={o.value}
              // mousedown would blur the button and close the list before the click lands
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o)}
              className={
                "cursor-pointer truncate rounded-[calc(var(--radius-control)-2px)] px-2.5 py-2 text-[0.8125rem] text-[var(--foreground)] hover:bg-[var(--neutral-50)] " +
                (o.value === current ? "font-medium" : "")
              }
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

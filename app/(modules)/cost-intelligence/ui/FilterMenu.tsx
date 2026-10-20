"use client";

import { ListFilter } from "lucide-react";
import { useState } from "react";
import type { DropdownOption } from "./Dropdown";

/** A filter icon that opens a small list of options. Sits beside a table header. */
export function FilterMenu({
  label,
  options,
  value,
  onChange,
}: {
  /** What is being filtered, for the accessible name: "Filter by {label}". */
  label: string;
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={`Filter by ${label}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onBlur={() => setOpen(false)}
        className={
          "rounded p-0.5 hover:bg-[var(--neutral-100)] focus-visible:rounded! focus-visible:bg-[var(--neutral-100)] focus-visible:outline-none! " +
          (value ? "text-[var(--foreground)]" : "text-[var(--muted)]")
        }
      >
        <ListFilter size={14} aria-hidden="true" />
      </button>

      {open && (
        <ul className="absolute left-0 top-full z-20 mt-1 min-w-44 rounded-[var(--radius-control)] border border-[var(--border)] bg-white p-1 text-[0.8125rem] font-normal normal-case tracking-normal text-[var(--foreground)] shadow-lg">
          {options.map((o) => (
            <li
              key={o.value}
              // mousedown would blur the button and close the list before the click lands
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={
                "cursor-pointer truncate rounded-[calc(var(--radius-control)-2px)] px-2.5 py-2 hover:bg-[var(--neutral-50)] " +
                (o.value === value ? "font-medium" : "")
              }
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

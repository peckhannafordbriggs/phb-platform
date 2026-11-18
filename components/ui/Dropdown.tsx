"use client";

import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";

export type DropdownOption = { value: string; label: string };

/**
 * A select with the kit's own list. Click or Enter / Space / ArrowDown opens
 * it; the arrow keys move, Enter chooses, Escape closes, and typing a letter
 * jumps to the next option that starts with it - what a native select does,
 * so a picker of thirty points is usable without a mouse (2026-11-10). Blur
 * closes it.
 */
export function Dropdown({
  options,
  placeholder,
  value,
  onChange,
  label,
  disabled = false,
  className = "",
}: {
  options: DropdownOption[];
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const [internal, setInternal] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  const current = value ?? internal;
  const selected = options.find((o) => o.value === current);

  function choose(option: DropdownOption) {
    if (value === undefined) setInternal(option.value);
    onChange?.(option.value);
    setOpen(false);
  }

  function show() {
    const at = options.findIndex((o) => o.value === current);
    setActive(at === -1 ? 0 : at);
    setOpen(true);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (options.length === 0) return;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const option = options[active];
      if (option !== undefined) choose(option);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key.length === 1 && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const letter = e.key.toLowerCase();
      const from = active + 1;
      for (let step = 0; step < options.length; step++) {
        const i = (from + step) % options.length;
        if (options[i]!.label.toLowerCase().startsWith(letter)) {
          setActive(i);
          break;
        }
      }
    }
  }

  return (
    <div className={"relative " + className}>
      <button
        type="button"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        className={
          "flex h-10 w-full items-center rounded-[var(--radius-control)] border border-[var(--border)] bg-white pl-3 pr-9 text-left text-[0.8125rem] focus-visible:rounded-[var(--radius-control)]! focus-visible:border-[var(--neutral-500)] focus-visible:outline-none! disabled:opacity-50 " +
          (selected ? "text-[var(--foreground)]" : "text-[var(--muted)]")
        }
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
      </button>
      <ChevronDown
        size={14}
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)]"
      />

      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-[var(--radius-control)] border border-[var(--border)] bg-white p-1 shadow-lg"
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === current}
              // mousedown would blur the button and close the list before the click lands
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(o)}
              className={
                "cursor-pointer truncate rounded-[calc(var(--radius-control)-2px)] px-2.5 py-2 text-[0.8125rem] text-[var(--foreground)] hover:bg-[var(--neutral-50)] " +
                (o.value === current ? "font-medium " : "") +
                (i === active ? "bg-[var(--neutral-50)]" : "")
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

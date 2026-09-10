"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How many panes fit, and how wide the resizable ones are.
 *
 * The module had no breakpoints at all and two hard-coded widths - `w-52` and
 * `w-80` - which meant 528px of fixed chrome at every viewport. On a 2560px
 * monitor the message list stayed at 320px while 2000px went to the reading
 * pane; below about 1100px the panes did not degrade, they just ran out of
 * room. Both halves of that are fixed here: the widths are draggable and
 * remembered, and the pane COUNT responds to the viewport.
 */

/** Three panes, two, or one. */
export type LayoutMode = "wide" | "medium" | "narrow";

/**
 * Where the two thresholds sit.
 *
 * 1100px is where three panes stop fitting at their minimum widths: 168 + 288
 * leaves 644px for a reading pane, and a vendor's email with a quoted reply
 * chain needs more than that. Below it the folder tree becomes a disclosure,
 * which is the right thing to lose first - it is navigated once per session
 * where the list is scanned continuously.
 *
 * 700px is where the list and the reading pane stop coexisting, so the module
 * shows one at a time and the reading pane gets a way back.
 */
const MEDIUM_MAX = 1099;
const NARROW_MAX = 699;

export const PANE_LIMITS = {
  folders: { min: 168, max: 320, initial: 208 },
  list: { min: 288, max: 520, initial: 320 },
} as const;

export type PaneKey = keyof typeof PANE_LIMITS;

const STORAGE_KEY = "phb.co.paneWidths";

function clamp(key: PaneKey, value: number): number {
  const { min, max } = PANE_LIMITS[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * The viewport's pane count.
 *
 * Read in an effect rather than during render, for the same reason the grouping
 * preference is: touching `window` while rendering is a hydration mismatch. The
 * server and the first client paint both assume `wide`, and a narrow viewport
 * corrects on mount. The cost is one frame of the wrong layout on a phone,
 * which is preferable to the whole tree being client-only.
 */
export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>("wide");

  useEffect(() => {
    const narrow = window.matchMedia(`(max-width: ${NARROW_MAX}px)`);
    const medium = window.matchMedia(`(max-width: ${MEDIUM_MAX}px)`);

    const read = () => {
      setMode(narrow.matches ? "narrow" : medium.matches ? "medium" : "wide");
    };

    read();
    narrow.addEventListener("change", read);
    medium.addEventListener("change", read);
    return () => {
      narrow.removeEventListener("change", read);
      medium.removeEventListener("change", read);
    };
  }, []);

  return mode;
}

interface PaneWidths {
  folders: number;
  list: number;
}

/**
 * Draggable pane widths, remembered per browser.
 *
 * Clamped on read as well as on write, so a stored width from an older build -
 * or a hand-edited one - cannot produce a pane too narrow to use. The clamp is
 * the invariant; localStorage is only a hint.
 */
export function usePaneWidths(): {
  widths: PaneWidths;
  setWidth: (key: PaneKey, px: number) => void;
  resetWidth: (key: PaneKey) => void;
} {
  const [widths, setWidths] = useState<PaneWidths>({
    folders: PANE_LIMITS.folders.initial,
    list: PANE_LIMITS.list.initial,
  });

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return;
      const record = parsed as Partial<Record<PaneKey, unknown>>;
      setWidths((current) => ({
        folders:
          typeof record.folders === "number"
            ? clamp("folders", record.folders)
            : current.folders,
        list:
          typeof record.list === "number" ? clamp("list", record.list) : current.list,
      }));
    } catch {
      // Storage disabled, or a value that will not parse. Defaults stand.
    }
  }, []);

  const persist = useCallback((next: PaneWidths) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Not remembering a pane width is not worth failing over.
    }
  }, []);

  const setWidth = useCallback(
    (key: PaneKey, px: number) => {
      setWidths((current) => {
        const next = { ...current, [key]: clamp(key, px) };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const resetWidth = useCallback(
    (key: PaneKey) => {
      setWidths((current) => {
        const next = { ...current, [key]: PANE_LIMITS[key].initial };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  return { widths, setWidth, resetWidth };
}

/**
 * Pointer and keyboard driving for one resize handle.
 *
 * Pointer events rather than mouse events so a trackpad, a pen and a touch
 * drag all work from one path, with setPointerCapture so the drag survives the
 * pointer leaving the 6px handle - which it will, immediately, on the first
 * fast drag.
 *
 * Keyboard matters as much as the drag here: a separator that can only be moved
 * by dragging is not operable without a mouse, and WCAG 2.2 treats that as a
 * failure rather than a nicety. Arrow keys nudge, Home and End jump to the
 * limits, Enter restores the default.
 */
export function useResizeHandle(
  key: PaneKey,
  width: number,
  setWidth: (key: PaneKey, px: number) => void,
  resetWidth: (key: PaneKey) => void,
) {
  const startX = useRef(0);
  const startWidth = useRef(0);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Left button or a touch/pen contact only; a right-click must not drag.
      if (event.button !== 0) return;
      event.preventDefault();
      startX.current = event.clientX;
      startWidth.current = width;
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [width],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      setWidth(key, startWidth.current + (event.clientX - startX.current));
    },
    [dragging, key, setWidth],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [dragging],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 48 : 16;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setWidth(key, width - step);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setWidth(key, width + step);
      } else if (event.key === "Home") {
        event.preventDefault();
        setWidth(key, PANE_LIMITS[key].min);
      } else if (event.key === "End") {
        event.preventDefault();
        setWidth(key, PANE_LIMITS[key].max);
      } else if (event.key === "Enter") {
        event.preventDefault();
        resetWidth(key);
      }
    },
    [key, resetWidth, setWidth, width],
  );

  return { dragging, onPointerDown, onPointerMove, onPointerUp, onKeyDown };
}

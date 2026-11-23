"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The width of an element, kept current as it resizes (2026-11-23). The time
 * charts need it to decide how many x-axis ticks fit: ResponsiveContainer
 * hands the chart its size through context, which the component that chooses
 * the ticks cannot read. Null until measured, and always in an environment
 * with no ResizeObserver (a jsdom test), where the chart is given its width.
 */
export function useMeasuredWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number | null] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

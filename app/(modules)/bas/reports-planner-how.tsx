"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { HIDE_HOW_LABEL, PlannerHowPanel, SHOW_HOW_LABEL, hasPlannerDetails } from "@/lib/modules/bas/reports/engine/planner-display";
import type { PlannerAnswer } from "@/lib/modules/bas/reports/engine/types";

/**
 * Under each planner answer on the web run view (2026-11-16): a kit
 * secondary Button, "Show how this was answered", that opens the panel
 * with the planner's reading of the question, every point, the SQL and the
 * cost, and reads "Hide" while it is open. Collapsed by default.
 *
 * The run page passes this into ReportView's `plannerDetails` slot; the
 * stored HTML the worker prints is rendered with no slot, so the PDF never
 * carries it, and REPORT_CSS hides `.planner-how` under `@media print` for
 * the web page's own Print.
 */
export function PlannerHowToggle({ answer, timezone, defaultOpen = false }: { answer: PlannerAnswer; timezone: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!hasPlannerDetails(answer)) return null;
  return (
    <div className="planner-how">
      <Button variant="secondary" size="sm" ariaExpanded={open} onClick={() => setOpen((v) => !v)} testId="planner-how-toggle">
        {open ? HIDE_HOW_LABEL : SHOW_HOW_LABEL}
      </Button>
      {open && <PlannerHowPanel answer={answer} timezone={timezone} />}
    </div>
  );
}

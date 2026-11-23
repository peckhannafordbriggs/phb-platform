"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui";

/**
 * The Reports tab's confirmation (2026-11-20): a heading that names what is
 * about to happen, one sentence on what follows from it, Cancel and the red
 * button. Deleting runs and deleting a report both use it. Cancel takes the
 * focus, so Enter on an open dialog never confirms; Escape closes it.
 */
export function ConfirmDialog({
  heading,
  sentence,
  confirmLabel,
  busyLabel,
  busy = false,
  testIdPrefix,
  onCancel,
  onConfirm,
}: {
  heading: string;
  sentence: string;
  confirmLabel: string;
  busyLabel: string;
  busy?: boolean;
  /** `<prefix>-dialog`, `<prefix>-cancel`, `<prefix>-confirm`. */
  testIdPrefix: string;
  onCancel?: () => void;
  onConfirm?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(`[data-testid='${testIdPrefix}-cancel']`)?.focus();
  }, [testIdPrefix]);
  const headingId = `${testIdPrefix}-heading`;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel?.();
        }}
        className="card w-full max-w-md p-5"
        data-testid={`${testIdPrefix}-dialog`}
      >
        <h2 id={headingId} className="text-base font-semibold">
          {heading}
        </h2>
        <p className="mt-2 text-sm text-[var(--muted)]">{sentence}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button disabled={busy} onClick={onCancel} testId={`${testIdPrefix}-cancel`}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={onConfirm} testId={`${testIdPrefix}-confirm`}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

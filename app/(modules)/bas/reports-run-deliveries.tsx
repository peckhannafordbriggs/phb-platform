"use client";

import { Mail, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import {
  SOURCE_WORDS,
  countDeliveries,
  deliveryDetail,
  deliveryStatusLabel,
  describeDelivery,
  type DeliveryRowView,
  type DeliverySummary,
} from "@/lib/modules/bas/reports/delivery-words";
import type { RunSummary } from "@/lib/modules/bas/reports/runs-service";
import { ApiError } from "./health-client";
import { fetchRun, resendRunEmail, sendRunToMe } from "./reports-client";
import { TONE_STYLE } from "./tone";

/**
 * The email of one run (Reports, Phase 4, the email half - 2026-11-17).
 *
 * On the Reports list, `DeliveryCell`: the column's phrase - "3 of 3 sent",
 * "1 failed", "Not sent — sending disabled" - and Resend beside it when an
 * address failed. On the run page, `RunDeliveries`: one row per address,
 * owner first, with its state, its attempts and why it failed, and the two
 * actions - Resend (failed rows only) and Send to me (a copy to your own
 * address). Neither sends anything: each writes a row and the worker job
 * sends it, so the panel polls while a row is waiting.
 *
 * The card sits outside the report's print section, so Print never prints
 * it.
 */

export const DELIVERY_POLL_MS = 10_000;

export function DeliveryCell({
  run,
  onResend,
  busy = false,
}: {
  run: Pick<RunSummary, "runId" | "delivery">;
  onResend?: (runId: string) => void;
  busy?: boolean;
}) {
  const d = run.delivery;
  const detail = deliveryDetail(d);
  return (
    <div className="flex flex-col gap-1">
      <span className={d.failed > 0 ? "text-[var(--danger)]" : "text-[var(--muted)]"} data-testid="run-delivery-state">
        {describeDelivery(d)}
      </span>
      {detail !== null && <span className="max-w-[16rem] text-[var(--muted)]">{detail}</span>}
      {d.failed > 0 && onResend !== undefined && (
        <div>
          <Button size="sm" disabled={busy} onClick={() => onResend(run.runId)} testId="run-resend">
            Resend
          </Button>
        </div>
      )}
    </div>
  );
}

function summaryOf(rows: DeliveryRowView[], fallback: DeliverySummary): DeliverySummary {
  return rows.length === 0 ? fallback : { ...countDeliveries(rows), emptyReason: null };
}

const when = (iso: string, timezone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export function RunDeliveries({
  runId,
  status,
  timezone,
  deliveries: initialRows,
  summary: initialSummary,
}: {
  runId: string;
  status: RunSummary["status"];
  timezone: string;
  deliveries: DeliveryRowView[];
  summary: DeliverySummary;
}) {
  const [rows, setRows] = useState(initialRows);
  const [summary, setSummary] = useState(initialSummary);
  const [busy, setBusy] = useState<"resend" | "me" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const waiting = rows.some((r) => r.status === "pending") || summary.emptyReason === "waiting_for_pdf";
  const finished = status === "succeeded" || status === "partial";
  const counts = summaryOf(rows, summary);

  async function reload() {
    const run = await fetchRun(runId);
    setRows(run.deliveries);
    setSummary(run.delivery);
  }

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload().catch(() => undefined);
    }, DELIVERY_POLL_MS);
    return () => clearInterval(timer);
    // reload reads only runId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, runId]);

  async function act(kind: "resend" | "me") {
    setBusy(kind);
    setMessage(null);
    try {
      if (kind === "resend") {
        const r = await resendRunEmail(runId);
        setMessage({ tone: "ok", text: `${r.requeued} failed email${r.requeued === 1 ? "" : "s"} queued again. The worker sends ${r.requeued === 1 ? "it" : "them"} shortly.` });
      } else {
        const r = await sendRunToMe(runId);
        setMessage({ tone: "ok", text: `A copy to ${r.email} is queued. The worker sends it shortly.` });
      }
      await reload();
    } catch (cause) {
      setMessage({ tone: "bad", text: cause instanceof ApiError ? cause.message : "Something went wrong." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card p-4" data-testid="run-deliveries">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Email</h2>
          <p className="text-[0.8125rem] text-[var(--muted)]" data-testid="run-deliveries-summary">
            {describeDelivery(counts)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {counts.failed > 0 && (
            <Button size="sm" disabled={busy !== null} onClick={() => void act("resend")} testId="run-resend">
              <RefreshCw size={14} aria-hidden="true" />
              Resend
            </Button>
          )}
          {finished && (
            <Button size="sm" disabled={busy !== null} onClick={() => void act("me")} testId="run-send-to-me">
              <Mail size={14} aria-hidden="true" />
              Send to me
            </Button>
          )}
        </div>
      </div>
      {message !== null && (
        <p className="mt-3 rounded-[var(--radius-row)] border p-2 text-[0.8125rem]" style={TONE_STYLE[message.tone]} role={message.tone === "bad" ? "alert" : "status"}>
          {message.text}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="mt-3 text-[0.8125rem] text-[var(--muted)]">{deliveryDetail(summary) ?? "No email has been queued for this run."}</p>
      ) : (
        <div className="mt-3 max-h-72 overflow-auto">
          <table className="w-full text-[0.8125rem]">
            <thead className="sticky top-0 bg-[var(--surface)] text-left text-[var(--muted)]">
              <tr>
                <th className="eyebrow py-2 pr-3 text-[var(--muted)]">Address</th>
                <th className="eyebrow py-2 pr-3 text-[var(--muted)]">As</th>
                <th className="eyebrow py-2 pr-3 text-[var(--muted)]">State</th>
                <th className="eyebrow py-2 pr-3 text-[var(--muted)]">Attempts</th>
                <th className="eyebrow py-2 text-[var(--muted)]">Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.deliveryId} className="border-t border-[var(--divider-soft)] align-top" data-testid="run-delivery-row">
                  <td className="py-2 pr-3">
                    {r.email}
                    {r.isExternal && <span className="ml-1 rounded-full border px-1.5 text-[0.6875rem] text-[var(--muted)]">external</span>}
                  </td>
                  <td className="py-2 pr-3 text-[var(--muted)]">{SOURCE_WORDS[r.source]}</td>
                  <td className={`py-2 pr-3 ${r.status === "failed" ? "text-[var(--danger)]" : ""}`}>{deliveryStatusLabel(r.status)}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.attempts}</td>
                  <td className="py-2 text-[var(--muted)]">
                    {r.status === "sent" && r.sentAt !== null
                      ? `Sent ${when(r.sentAt, timezone)}`
                      : r.status === "pending" && r.nextAttemptAt !== null && r.attempts > 0
                        ? `${r.lastError ?? ""} Next attempt ${when(r.nextAttemptAt, timezone)}.`
                        : (r.lastError ?? "")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

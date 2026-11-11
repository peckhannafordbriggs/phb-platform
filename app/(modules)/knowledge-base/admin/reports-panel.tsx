"use client";

import Link from "next/link";
import { useState } from "react";
import type { KbReportView } from "@/lib/modules/knowledge-base/reports";
import { KB_REPORT_REASON_LABELS } from "@/lib/modules/knowledge-base/types";

/**
 * Reported answers, for Knowledge Base module admins: the question, the answer
 * as it was shown, what the reporter says is wrong. Close each as resolved
 * (something was wrong and was dealt with) or dismissed (the answer was
 * right), with a note saying what you found.
 */

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });

function ReportItem({ report, onClosed }: { report: KbReportView; onClosed: (id: string) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = report.citationN ? report.question.answer.sources.find((s) => s.n === report.citationN) : null;

  async function close(status: "resolved" | "dismissed") {
    if (!note.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/modules/knowledge-base/reports/${report.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, note: note.trim() }),
      });
      if (response.ok || response.status === 409) {
        onClosed(report.id);
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="card space-y-3 p-5 text-sm">
      <div>
        <p className="font-medium">{KB_REPORT_REASON_LABELS[report.reason]}</p>
        <p className="text-xs text-[var(--muted)]">
          {report.reportedBy ?? "A former employee"} · {when(report.createdAt)}
        </p>
        {report.comment && <p className="mt-1 whitespace-pre-line">&ldquo;{report.comment}&rdquo;</p>}
        {source && (
          <p className="mt-1 text-[var(--muted)]">
            About source [{source.n}]: {source.fileName}
          </p>
        )}
      </div>
      <div className="rounded-[var(--radius-control)] bg-[var(--surface)] p-3">
        <p className="font-medium">{report.question.text}</p>
        <p className="mt-1 whitespace-pre-line">{report.question.answer.text}</p>
        <Link href={`/knowledge-base?c=${report.question.conversationId}`} className="mt-1 inline-block text-xs underline underline-offset-2">
          Open the answer with its sources
        </Link>
      </div>
      {report.resolution ? (
        <p className="text-[var(--muted)]">
          {report.status === "resolved" ? "Resolved" : "Dismissed"} by {report.resolution.by ?? "a former employee"} on{" "}
          {when(report.resolution.at)}: {report.resolution.note}
        </p>
      ) : (
        <div className="space-y-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={2}
            placeholder="What you found (required)"
            className="w-full rounded-[var(--radius-control)] border border-[var(--border)] bg-white p-2"
          />
          {error && (
            <p role="alert" className="text-[var(--danger)]">
              {error}
            </p>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              disabled={!note.trim() || busy}
              onClick={() => void close("resolved")}
              className="inline-flex h-8 items-center rounded-[var(--radius-control)] bg-[var(--module-accent)] px-3 text-[0.8125rem] font-medium text-white disabled:pointer-events-none disabled:opacity-50"
            >
              Resolved
            </button>
            <button
              type="button"
              disabled={!note.trim() || busy}
              onClick={() => void close("dismissed")}
              className="inline-flex h-8 items-center rounded-[var(--radius-control)] border border-[var(--border)] px-3 text-[0.8125rem] font-medium disabled:pointer-events-none disabled:opacity-50"
            >
              Dismiss: the answer was right
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function ReportsPanel({ initial }: { initial: KbReportView[] }) {
  const [view, setView] = useState<"open" | "closed">("open");
  const [reports, setReports] = useState(initial);
  const [loading, setLoading] = useState(false);

  async function show(next: "open" | "closed") {
    setView(next);
    setLoading(true);
    try {
      const response = await fetch(`/api/modules/knowledge-base/reports?status=${next}`, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { data?: KbReportView[] } | null;
      setReports(body?.data ?? []);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">Reported answers</h2>
        <div className="flex gap-4 text-sm">
          {(["open", "closed"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => void show(v)}
              className={view === v ? "font-medium" : "text-[var(--muted)] underline underline-offset-2"}
            >
              {v === "open" ? "Open" : "Closed"}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <p className="mt-3 text-sm text-[var(--muted)]">Loading…</p>
      ) : reports.length === 0 ? (
        <div className="card mt-3 p-6 text-center text-sm text-[var(--muted)]">
          {view === "open" ? "No answers are waiting to be checked." : "No report has been closed yet."}
        </div>
      ) : (
        <ul className="mt-3 space-y-3">
          {reports.map((r) => (
            <ReportItem key={r.id} report={r} onClosed={(id) => setReports((all) => all.filter((x) => x.id !== id))} />
          ))}
        </ul>
      )}
    </section>
  );
}

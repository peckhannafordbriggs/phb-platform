"use client";

import { useState } from "react";
import type { KbAskedQuestion } from "@/lib/modules/knowledge-base/ask";
import { locationLabel } from "@/lib/modules/knowledge-base/location";
import { KB_REPORT_REASONS, KB_REPORT_REASON_LABELS, type KbReportReason } from "@/lib/modules/knowledge-base/types";
import { OlderTag } from "./search-panel";

/**
 * One question and its answer as saved: the answer, with each citation linked
 * to its source beneath; what the documents do not say and where sources
 * disagree, when either applies; each source as its file and page. Nothing
 * else - no timing, no counts. Read from the snapshot in the history, so it
 * shows the same after a rebuild.
 *
 * Under it, "Report a wrong answer" (lib/modules/knowledge-base/reports.ts).
 */

const CITE = /(\[\d+\])/g;

/** "Page 8" reads as "file.pdf, page 8"; a sheet's own name keeps its case. */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function AnswerText({ text, anchor }: { text: string; anchor: (n: number) => string }) {
  const withCitations = (line: string) =>
    line.split(CITE).map((part, i) => {
      const m = /^\[(\d+)\]$/.exec(part);
      return m ? (
        <a key={i} href={`#${anchor(Number(m[1]))}`} className="align-super text-[0.7rem] font-semibold text-[var(--module-accent-ink)] no-underline">
          [{m[1]}]
        </a>
      ) : (
        part
      );
    });
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`l${blocks.length}`} className="ml-5 list-disc space-y-0.5">
        {list.map((item, i) => (
          <li key={i}>{withCitations(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (const line of text.split("\n")) {
    if (/^\s*- /.test(line)) list.push(line.replace(/^\s*- /, ""));
    else {
      flush();
      if (line.trim()) blocks.push(<p key={`p${blocks.length}`}>{withCitations(line)}</p>);
    }
  }
  flush();
  return <div className="space-y-2 text-[0.9375rem] leading-relaxed">{blocks}</div>;
}

function ReportForm({ asked, onDone }: { asked: KbAskedQuestion; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<KbReportReason | null>(null);
  const [source, setSource] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-[var(--muted)] underline underline-offset-2">
        Report a wrong answer
      </button>
    );
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!reason || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/modules/knowledge-base/questions/${asked.id}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason,
          ...(source ? { citationN: Number(source) } : {}),
          ...(comment.trim() ? { comment: comment.trim() } : {}),
        }),
      });
      if (response.ok) {
        onDone();
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? "The report did not go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void send(e)} className="mt-1 space-y-3 text-left rounded-[var(--radius-control)] border border-[var(--border)] p-4 text-sm">
      <fieldset className="space-y-1">
        <legend className="mb-1 font-medium">What is wrong?</legend>
        {KB_REPORT_REASONS.map((r) => (
          <label key={r} className="flex items-center gap-2">
            <input type="radio" name={`reason-${asked.id}`} checked={reason === r} onChange={() => setReason(r)} />
            {KB_REPORT_REASON_LABELS[r]}
          </label>
        ))}
      </fieldset>
      {asked.answer.sources.length > 0 && (
        <label className="flex flex-col gap-1">
          <span>Which source? (optional)</span>
          <select value={source} onChange={(e) => setSource(e.target.value)} className="h-8 max-w-xs rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-2">
            <option value="">Not about one source</option>
            {asked.answer.sources.map((s) => (
              <option key={s.n} value={s.n}>
                [{s.n}] {s.fileName}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span>What should it say? (optional)</span>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={2000}
          rows={3}
          className="rounded-[var(--radius-control)] border border-[var(--border)] bg-white p-2"
        />
      </label>
      {error && (
        <p role="alert" className="text-[var(--danger)]">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={!reason || busy}
          className="inline-flex h-8 items-center rounded-[var(--radius-control)] bg-[var(--module-accent)] px-3 text-[0.8125rem] font-medium text-white disabled:pointer-events-none disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send report"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-sm underline underline-offset-2">
          Cancel
        </button>
      </div>
    </form>
  );
}

export function AnswerCard({ asked }: { asked: KbAskedQuestion }) {
  const [reported, setReported] = useState(asked.reportedByMe);
  const a = asked.answer;
  const anchor = (n: number) => `src-${asked.id}-${n}`;
  // Fixed locale and zone: the server renders this first, and the browser must agree.
  const when = new Date(asked.createdAt).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  });
  return (
    <article className="space-y-3">
      <div>
        <p className="font-medium">{asked.question}</p>
        <p className="text-xs text-[var(--muted)]">
          {asked.askedBy?.name ?? "A former employee"} · {when}
        </p>
      </div>

      <div className={`card p-5 ${a.kind === "no_evidence" ? "border-dashed" : ""}`}>
        <AnswerText text={a.text} anchor={anchor} />
        {a.missing && (
          <p className="mt-3 text-sm text-[var(--muted)]">
            <span className="font-medium text-[var(--foreground)]">Not in the documents: </span>
            {a.missing}
          </p>
        )}
        {a.conflicts.map((c, i) => (
          <p key={i} className="mt-2 text-sm text-[var(--warning)]">
            <span className="font-medium">Sources disagree on {c.about}: </span>
            {c.sources.map((n) => (
              <a key={n} href={`#${anchor(n)}`} className="mr-1 underline underline-offset-2">
                [{n}]
              </a>
            ))}
          </p>
        ))}

        {a.sources.length > 0 && (
          <ol className="mt-4 space-y-1.5 border-t border-[var(--divider-soft)] pt-3 text-sm">
            {a.sources.map((s) => (
              <li key={s.n} id={anchor(s.n)} className="scroll-mt-24">
                <span className="mr-1.5 font-semibold text-[var(--module-accent-ink)]">[{s.n}]</span>
                <OlderTag copy={s} />
                {s.webUrl ? (
                  <a href={s.webUrl} target="_blank" rel="noreferrer" className="break-all underline underline-offset-2">
                    {s.fileName}
                  </a>
                ) : (
                  <span className="break-all">{s.fileName}</span>
                )}
                <span className="text-[var(--muted)]">, {lowerFirst(locationLabel(s))}</span>
                <details className="mt-0.5">
                  <summary className="cursor-pointer text-xs text-[var(--muted)]">Show the passage</summary>
                  <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-[var(--muted)]">{s.excerpt}</p>
                </details>
              </li>
            ))}
          </ol>
        )}

        <div className="mt-3 text-right">
          {reported ? (
            <span className="text-xs text-[var(--muted)]">Reported. A Knowledge Base admin will look at it.</span>
          ) : (
            <ReportForm asked={asked} onDone={() => setReported(true)} />
          )}
        </div>
      </div>
    </article>
  );
}

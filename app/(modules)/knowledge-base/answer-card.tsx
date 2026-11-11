"use client";

import type { KbAskedQuestion } from "@/lib/modules/knowledge-base/ask";
import { locationLabel } from "@/lib/modules/knowledge-base/location";
import { OlderTag } from "./search-panel";

/**
 * One question and its answer as saved: the answer text with its numbered
 * citations linked to the sources beneath, what the documents do not say,
 * where sources disagree, and each source with the passage it came from. Read
 * from the snapshot in the history, so it shows the same after a rebuild.
 */

const CITE = /(\[\d+\])/g;

function AnswerText({ text, anchor }: { text: string; anchor: (n: number) => string }) {
  const lines = text.split("\n").filter((l, i, all) => l.trim().length > 0 || (i > 0 && i < all.length - 1));
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
  for (const line of lines) {
    if (/^\s*- /.test(line)) list.push(line.replace(/^\s*- /, ""));
    else {
      flush();
      if (line.trim()) blocks.push(<p key={`p${blocks.length}`}>{withCitations(line)}</p>);
    }
  }
  flush();
  return <div className="space-y-2 text-[0.9375rem] leading-relaxed">{blocks}</div>;
}

export function AnswerCard({ asked }: { asked: KbAskedQuestion }) {
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
          <ol className="mt-4 space-y-2 border-t border-[var(--divider-soft)] pt-3 text-sm">
            {a.sources.map((s) => (
              <li key={s.n} id={anchor(s.n)} className="scroll-mt-24">
                <span className="mr-1.5 font-semibold text-[var(--module-accent-ink)]">[{s.n}]</span>
                <OlderTag copy={s} />
                {s.webUrl ? (
                  <a href={s.webUrl} target="_blank" rel="noreferrer" className="break-all underline underline-offset-2">
                    {s.fileName}
                  </a>
                ) : (
                  <span className="break-all" title="Indexed from a local copy; no SharePoint link">
                    {s.fileName}
                  </span>
                )}
                <span className="text-xs text-[var(--muted)]">
                  {" "}
                  · {s.projectFolder} · {locationLabel(s)}
                  {s.versionLabel ? ` · ${s.versionLabel}` : ""}
                </span>
                <details className="mt-0.5">
                  <summary className="cursor-pointer text-xs text-[var(--muted)]">The passage</summary>
                  <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-[var(--muted)]">{s.excerpt}</p>
                </details>
              </li>
            ))}
          </ol>
        )}

        <p className="mt-3 text-xs text-[var(--muted)]">
          {a.considered > 0 ? `Read ${a.considered} passage${a.considered === 1 ? "" : "s"}` : "No passage was relevant enough to read"}
          {asked.durationMs !== null && ` · ${(asked.durationMs / 1000).toFixed(1)} s`}
          {a.notices.map((n) => ` · ${n}`)}
        </p>
      </div>
    </article>
  );
}

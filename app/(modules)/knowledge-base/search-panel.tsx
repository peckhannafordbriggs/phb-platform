"use client";

import { useState } from "react";
import type { KbSearchHit, KbSearchResult } from "@/lib/modules/knowledge-base/search";

/**
 * The Knowledge Base search box: keyword search over indexed passages, every
 * result citing the file and the exact place in it. No answer is written yet;
 * this is the evidence an answer will be built from.
 */

// The same markers search.ts asks ts_headline for. Inlined rather than imported
// so the browser bundle does not pull in the database client.
const MARK_START = "\u0002";
const MARK_END = "\u0003";

type Project = { id: string; folderName: string; projectNumber: string | null; name: string };

function location(hit: KbSearchHit): string {
  if (hit.sheet) return hit.cellRange ? `Sheet "${hit.sheet}", ${hit.cellRange}` : `Sheet "${hit.sheet}"`;
  if (hit.pageStart !== null) {
    return hit.pageEnd !== null && hit.pageEnd !== hit.pageStart ? `Pages ${hit.pageStart}-${hit.pageEnd}` : `Page ${hit.pageStart}`;
  }
  if (hit.section) return `Section: ${hit.section}`;
  return "Whole file";
}

/** The snippet with matched words marked, as React nodes: never as HTML. */
function Snippet({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest.length > 0) {
    const start = rest.indexOf(MARK_START);
    if (start < 0) {
      parts.push(rest);
      break;
    }
    if (start > 0) parts.push(rest.slice(0, start));
    const end = rest.indexOf(MARK_END, start);
    const word = rest.slice(start + 1, end < 0 ? undefined : end);
    parts.push(
      <mark
        key={key++}
        className="bg-transparent font-semibold text-inherit underline decoration-[var(--module-accent)] decoration-2 underline-offset-2"
      >
        {word}
      </mark>,
    );
    rest = end < 0 ? "" : rest.slice(end + 1);
  }
  return <p className="mt-2 whitespace-pre-line text-sm leading-relaxed">{parts}</p>;
}

function Version({ hit }: { hit: KbSearchHit }) {
  const label = hit.isArchived ? "Archived version" : hit.isLatest ? "Current version" : "Older version";
  return (
    <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]">
      {label}
      {hit.versionLabel ? ` · ${hit.versionLabel}` : ""}
    </span>
  );
}

export function SearchPanel({ projects }: { projects: Project[] }) {
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [result, setResult] = useState<KbSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: query.trim() });
      if (project) params.append("project", project);
      const response = await fetch(`/api/modules/knowledge-base/search?${params}`, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as
        | { data?: KbSearchResult; error?: { message?: string } }
        | null;
      if (!response.ok || !body?.data) {
        setError(body?.error?.message ?? "The search did not work. Try again.");
        return;
      }
      setResult(body.data);
    } finally {
      setBusy(false);
    }
  }

  const projectName = (id: string) => projects.find((p) => p.id === id)?.folderName ?? "a project";

  return (
    <div className="mt-6 space-y-5">
      <form onSubmit={(e) => void search(e)} className="card flex flex-wrap items-end gap-3 p-5">
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">Search past projects</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='e.g. AV-1 CFM, "control valves" approved, RFI 446'
            maxLength={300}
            className="h-9 rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3"
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Project</span>
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="h-9 rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-2"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.folderName}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={busy || !query.trim()}
          className="inline-flex h-9 items-center rounded-[var(--radius-control)] bg-[var(--module-accent)] px-4 text-[0.8125rem] font-medium text-white hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
        >
          {busy ? "Searching…" : "Search"}
        </button>
      </form>

      {error && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      )}

      {result && (
        <section aria-live="polite">
          <p className="text-sm text-[var(--muted)]">
            {result.hits.length > 0
              ? `${result.hits.length} passage${result.hits.length === 1 ? "" : "s"}`
              : result.terms.length === 0 && result.mode === "keyword"
                ? "Those words are too common to search for. Try the equipment tag, a number or a product name."
                : "Nothing in the indexed documents matches that closely enough."}
            {result.scope.how === "from_question" &&
              ` · limited to ${result.scope.projectIds.map(projectName).join(", ")} from the job number`}
          </p>
          {result.notice && <p className="mt-1 text-sm text-[var(--muted)]">{result.notice}</p>}

          <ol className="mt-3 space-y-3">
            {result.hits.map((hit) => (
              <li key={hit.chunkId} className="card p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    {hit.webUrl ? (
                      <a
                        href={hit.webUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="break-all font-medium underline underline-offset-2"
                      >
                        {hit.fileName}
                      </a>
                    ) : (
                      <span className="break-all font-medium" title="Indexed from a local copy; no SharePoint link">
                        {hit.fileName}
                      </span>
                    )}
                    <div className="mt-0.5 text-xs text-[var(--muted)]">
                      {hit.projectFolder} · {location(hit)}
                    </div>
                  </div>
                  <Version hit={hit} />
                </div>
                <Snippet text={hit.snippet} />
                <p className="mt-2 text-xs text-[var(--muted)]">
                  {hit.matchedBy === "meaning"
                    ? "Found by meaning: none of the words, but close in subject"
                    : hit.matched.length < result.terms.length
                      ? `Holds ${hit.matched.length} of ${result.terms.length} words: ${hit.matched.join(", ")}`
                      : `Holds every word`}
                  {hit.matchedBy === "both" && ", and close in meaning"}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

"use client";

import { locationLabel } from "@/lib/modules/knowledge-base/location";
import type { KbSearchCopy, KbSearchHit, KbSearchResult } from "@/lib/modules/knowledge-base/search";

/**
 * The search results under an answer: every passage the search found, citing
 * the file and the exact place in it, any other files holding the same text,
 * and whether Claude judged it relevant. The evidence an answer was built from,
 * and the rest of what the search turned up.
 */

// The same markers search.ts asks ts_headline for. Inlined rather than imported
// so the browser bundle does not pull in the database client.
const MARK_START = "\u0002";
const MARK_END = "\u0003";

export type Project = { id: string; folderName: string; projectNumber: string | null; name: string };

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

/** An orange tag for an archived or older copy, so it is never mistaken for the current one. */
export function OlderTag({ copy }: { copy: Pick<KbSearchCopy, "isArchived" | "isLatest"> }) {
  const older = copy.isArchived ? "Archived" : copy.isLatest ? null : "Older version";
  if (!older) return null;
  return (
    <span className="mr-1.5 rounded-full border border-[var(--warning)] px-1.5 py-px text-[0.6875rem] font-medium text-[var(--warning)]">
      {older}
    </span>
  );
}

/** Other files holding the same text, so one passage is listed once. */
function AlsoIn({ copies }: { copies: KbSearchCopy[] }) {
  if (copies.length === 0) return null;
  return (
    <div className="mt-2 text-xs text-[var(--muted)]">
      Same text also in:
      <ul className="mt-1 space-y-0.5">
        {copies.map((copy) => (
          <li key={copy.chunkId} className="break-all">
            <OlderTag copy={copy} />
            {copy.webUrl ? (
              <a href={copy.webUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                {copy.fileName}
              </a>
            ) : (
              copy.fileName
            )}{" "}
            · {locationLabel(copy)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Version({ hit }: { hit: Pick<KbSearchHit, "isArchived" | "isLatest" | "versionLabel"> }) {
  const label = hit.isArchived ? "Archived version" : hit.isLatest ? "Current version" : "Older version";
  return (
    <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]">
      {label}
      {hit.versionLabel ? ` · ${hit.versionLabel}` : ""}
    </span>
  );
}

export function SearchResults({ result, projects }: { result: KbSearchResult; projects: Project[] }) {
  const projectName = (id: string) => projects.find((p) => p.id === id)?.folderName ?? "a project";
  return (
    <section aria-live="polite">
      <p className="text-sm text-[var(--muted)]">
        {result.hits.length > 0
          ? `${result.hits.length} passage${result.hits.length === 1 ? "" : "s"}`
          : result.terms.length === 0 && result.mode === "keyword"
            ? "Those words are too common to search for. Try the equipment tag, a number or a product name."
            : "Nothing in the indexed documents matches that closely enough."}
        {result.scope.how === "from_question" &&
          ` · limited to ${result.scope.projectIds.map(projectName).join(", ")} from the job number`}
        {result.reranked && " · sorted by Claude"}
      </p>
      {result.notice && <p className="mt-1 text-sm text-[var(--muted)]">{result.notice}</p>}
      {result.rerankNotice && <p className="mt-1 text-sm text-[var(--muted)]">{result.rerankNotice}</p>}

      <ol className="mt-3 space-y-3">
        {result.hits.map((hit) => (
          <li key={hit.chunkId} className="card p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="min-w-0">
                {hit.webUrl ? (
                  <a href={hit.webUrl} target="_blank" rel="noreferrer" className="break-all font-medium underline underline-offset-2">
                    {hit.fileName}
                  </a>
                ) : (
                  <span className="break-all font-medium" title="Indexed from a local copy; no SharePoint link">
                    {hit.fileName}
                  </span>
                )}
                <div className="mt-0.5 text-xs text-[var(--muted)]">
                  {hit.projectFolder} · {locationLabel(hit)}
                </div>
              </div>
              <Version hit={hit} />
            </div>
            <Snippet text={hit.snippet} />
            <p className="mt-2 text-xs text-[var(--muted)]">
              {hit.relevant === true && <span className="font-medium text-[var(--foreground)]">Judged relevant · </span>}
              {hit.matchedBy === "meaning"
                ? "Found by meaning: none of the words, but close in subject"
                : hit.matched.length < result.terms.length
                  ? `Holds ${hit.matched.length} of ${result.terms.length} words: ${hit.matched.join(", ")}`
                  : "Holds every word"}
              {hit.matchedBy === "both" && ", and close in meaning"}
            </p>
            <AlsoIn copies={hit.alsoIn} />
          </li>
        ))}
      </ol>
    </section>
  );
}

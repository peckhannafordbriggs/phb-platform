"use client";

import { useCallback, useEffect, useState } from "react";
import { LIBRARY_SECTIONS } from "@/lib/modules/bas/reports/library";
import type { LibraryQuestionView, PersonalQuestionView } from "@/lib/modules/bas/reports/types";
import { ApiError } from "./health-client";
import { createPersonal, deletePersonal, fetchLibrary, fetchPersonal, updatePersonal } from "./reports-client";
import { TONE_STYLE } from "./tone";

const FIELD = "mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm";
const SMALL = "rounded border border-[var(--border)] px-2 py-0.5 text-xs disabled:opacity-50";

/**
 * The Library sub-tab: the shared library, read-only, grouped by section;
 * then the viewer's own questions with edit and delete. Promotion of a
 * personal question to the shared library is a later phase, and the screen
 * does not offer it.
 */
export function ReportsLibraryView() {
  const [library, setLibrary] = useState<LibraryQuestionView[] | null>(null);
  const [personal, setPersonal] = useState<PersonalQuestionView[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [lib, mine] = await Promise.all([fetchLibrary(signal), fetchPersonal(signal)]);
      setLibrary(lib);
      setPersonal(mine);
      setError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof ApiError ? cause : new ApiError("unexpected", "Something went wrong."));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await load();
        return true;
      } catch (cause) {
        setError(cause instanceof ApiError ? cause : new ApiError("unexpected", "Something went wrong."));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (library === null || personal === null) {
    return <p className="p-6 text-sm text-[var(--muted)]">{error?.message ?? "Loading the library…"}</p>;
  }

  return (
    <div className="space-y-6">
      {error !== null && (
        <p className="rounded-md border p-4 text-sm" style={TONE_STYLE.bad} role="alert">
          {error.message}
        </p>
      )}

      <SharedLibraryTable library={library} />

      <section className="card p-5">
        <h2 className="eyebrow text-[var(--muted)]">My library ({personal.length})</h2>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Questions you wrote and saved. Yours alone; they go on your own reports.
        </p>
        <ul className="mt-3 divide-y divide-[var(--divider-soft)] rounded border border-[var(--border)]">
          {personal.length === 0 && <li className="px-3 py-3 text-sm text-[var(--muted)]">Nothing saved yet.</li>}
          {personal.map((p) => (
            <PersonalRow
              key={p.personalQuestionId}
              question={p}
              busy={busy}
              onSave={(text) => run(() => updatePersonal(p.personalQuestionId, text))}
              onDelete={() => {
                if (window.confirm("Delete this question from your library?")) void run(() => deletePersonal(p.personalQuestionId));
              }}
            />
          ))}
        </ul>
        <div className="mt-3">
          <label className="block text-sm">
            <span className="font-medium">Save a new question</span>
            <textarea className={FIELD} rows={2} maxLength={1000} value={draft} onChange={(e) => setDraft(e.target.value)} />
          </label>
          <button
            type="button"
            className={SMALL + " mt-2"}
            disabled={busy || draft.trim().length === 0}
            onClick={() => {
              void run(() => createPersonal(draft.trim())).then((ok) => {
                if (ok) setDraft("");
              });
            }}
          >
            Save to my library
          </button>
        </div>
      </section>
    </div>
  );
}

/** Pure, for tests: the shared library grouped by section. */
export function SharedLibraryTable({ library }: { library: LibraryQuestionView[] }) {
  return (
    <section className="card p-0">
      <div className="px-5 py-4">
        <h2 className="eyebrow text-[var(--muted)]">Shared library ({library.length})</h2>
        <p className="mt-2 text-sm text-[var(--muted)]">
          <span className="font-medium">computed</span> questions are answered by code over the points named;{" "}
          <span className="font-medium">planner</span> questions by the Analyze planner. A question runs only
          when every point it needs is trended for at least the coverage shown.
        </p>
      </div>
      <div className="max-h-[36rem] overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left text-[var(--muted)]">
            <tr>
              <th className="px-5 py-2 font-medium">#</th>
              <th className="py-2 pr-3 font-medium">Question</th>
              <th className="py-2 pr-3 font-medium">Kind</th>
              <th className="py-2 pr-3 font-medium">Applies to</th>
              <th className="py-2 pr-3 font-medium">Points required</th>
              <th className="py-2 pr-3 font-medium">Coverage</th>
              <th className="py-2 pr-5 font-medium">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {LIBRARY_SECTIONS.map((section) => {
              const rows = library.filter((q) => q.section === section.key);
              if (rows.length === 0) return null;
              return [
                <tr key={`s-${section.key}`} className="border-t border-[var(--divider-soft)] bg-[var(--surface)]">
                  <td colSpan={7} className="px-5 py-1 font-medium">{section.label}</td>
                </tr>,
                ...rows.map((q) => (
                  <tr key={q.libraryQuestionId} className="border-t border-[var(--divider-soft)] align-top">
                    <td className="px-5 py-2 tabular-nums text-[var(--muted)]">{q.position}</td>
                    <td className="py-2 pr-3">{q.text}</td>
                    <td className="py-2 pr-3">
                      <span className="inline-block rounded border border-[var(--border)] px-1 text-[0.6875rem]">{q.kind}</span>
                    </td>
                    <td className="py-2 pr-3">{q.appliesToLabel}</td>
                    <td className="py-2 pr-3 text-[var(--muted)]">{q.requiredRolesText}</td>
                    <td className="py-2 pr-3 tabular-nums">{Math.round(q.minCoverage * 100)}%</td>
                    <td className="py-2 pr-5">{q.enabled ? "Yes" : "No"}</td>
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PersonalRow({
  question,
  busy,
  onSave,
  onDelete,
}: {
  question: PersonalQuestionView;
  busy: boolean;
  onSave: (text: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(question.text);

  if (editing) {
    return (
      <li className="px-3 py-2 text-sm">
        <textarea className={FIELD} rows={2} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="mt-2 flex gap-2">
          <button type="button" className={SMALL} disabled={busy || text.trim().length === 0} onClick={() => void onSave(text.trim()).then((ok) => ok && setEditing(false))}>
            Save
          </button>
          <button type="button" className={SMALL} disabled={busy} onClick={() => { setText(question.text); setEditing(false); }}>
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1">
        {question.text}
        <span className="ml-2 text-xs text-[var(--muted)]">
          used in {question.usedInReports} report{question.usedInReports === 1 ? "" : "s"}
        </span>
      </span>
      <span className="flex shrink-0 gap-1">
        <button type="button" className={SMALL} disabled={busy} onClick={() => setEditing(true)}>Edit</button>
        <button type="button" className={SMALL} disabled={busy || question.usedInReports > 0} title={question.usedInReports > 0 ? "Remove it from the reports that use it first." : undefined} onClick={onDelete}>
          Delete
        </button>
      </span>
    </li>
  );
}

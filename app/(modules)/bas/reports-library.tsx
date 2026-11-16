"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LIBRARY_SECTIONS } from "@/lib/modules/bas/reports/library";
import type { LibraryQuestionView, PersonalQuestionView, PromotionOptions } from "@/lib/modules/bas/reports/types";
import { ApiError } from "./health-client";
import {
  createPersonal,
  deletePersonal,
  fetchLibrary,
  fetchPersonal,
  fetchPromotionOptions,
  promoteQuestion,
  updatePersonal,
} from "./reports-client";
import { Button, INPUT } from "@/components/ui";
import { TONE_STYLE } from "./tone";

/** The kit's input, with the gap under its label and room for a textarea. */
const FIELD = `${INPUT} mt-1 h-auto py-2`;

/**
 * The Questions item of the Reports bar (Library on screen until
 * 2026-11-11; the route and the tables keep that name): the shared
 * questions, read-only, grouped by section;
 * then the viewer's own questions with edit and delete.
 *
 * PROMOTION (Phase 6). A BAS module admin may put one of their own saved
 * questions into the shared library as a planner question, with a section,
 * the equipment it applies to and the points it needs - from the personal
 * row (*Promote to shared*) or from the shared table (*Promote a question*,
 * which picks among their saved ones). Everyone else sees neither control;
 * the route refuses them regardless (403).
 */
export function ReportsLibraryView() {
  const [library, setLibrary] = useState<LibraryQuestionView[] | null>(null);
  const [personal, setPersonal] = useState<PersonalQuestionView[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [promotion, setPromotion] = useState<PromotionOptions | null>(null);
  /** The personal question whose promotion form is open, "pick" for the shared table's own, or null. */
  const [promoting, setPromoting] = useState<string | null>(null);
  const [promoted, setPromoted] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [lib, mine, options] = await Promise.all([fetchLibrary(signal), fetchPersonal(signal), fetchPromotionOptions(signal)]);
      setLibrary(lib);
      setPersonal(mine);
      setPromotion(options);
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

  const canPromote = promotion?.canPromote === true;
  const onPromote = (body: Parameters<typeof promoteQuestion>[0], text: string) =>
    run(() => promoteQuestion(body)).then((ok) => {
      if (ok) {
        setPromoting(null);
        setPromoted(text);
      }
      return ok;
    });

  if (library === null || personal === null) {
    return <p className="p-6 text-sm text-[var(--muted)]">{error?.message ?? "Loading the questions…"}</p>;
  }

  return (
    <div className="space-y-6">
      {error !== null && (
        <p className="rounded-[var(--radius-row)] border p-4 text-sm" style={TONE_STYLE.bad} role="alert">
          {error.message}
        </p>
      )}

      {promoted !== null && (
        <p className="rounded-[var(--radius-row)] border p-4 text-sm" style={TONE_STYLE.ok} role="status">
          Added to the shared questions: &ldquo;{promoted}&rdquo;. Everyone with Building Automation access can now tick it on a report.
        </p>
      )}

      <SharedLibraryTable
        library={library}
        action={
          canPromote && promoting !== "pick" ? (
            <Button size="sm" disabled={busy || personal.length === 0} title={personal.length === 0 ? "Save a question of your own first." : undefined} onClick={() => setPromoting("pick")}>
              Promote a question
            </Button>
          ) : null
        }
      />

      {canPromote && promotion !== null && promoting === "pick" && (
        <section className="card p-5">
          <h2 className="eyebrow text-[var(--muted)]">Promote one of your questions</h2>
          <PromoteForm options={promotion} personal={personal} busy={busy} onCancel={() => setPromoting(null)} onSubmit={onPromote} />
        </section>
      )}

      <section className="card p-5">
        <h2 className="eyebrow text-[var(--muted)]">My questions ({personal.length})</h2>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Questions you wrote and saved. Yours alone; they go on your own reports.
        </p>
        <ul className="mt-3 divide-y divide-[var(--divider-soft)] rounded-[var(--radius-row)] border border-[var(--border)]">
          {personal.length === 0 && <li className="px-3 py-3 text-sm text-[var(--muted)]">Nothing saved yet.</li>}
          {personal.map((p) => (
            <PersonalRow
              key={p.personalQuestionId}
              question={p}
              busy={busy}
              promote={
                canPromote && promotion !== null
                  ? {
                      open: promoting === p.personalQuestionId,
                      onOpen: () => setPromoting(p.personalQuestionId),
                      form: (
                        <PromoteForm
                          options={promotion}
                          personal={[p]}
                          busy={busy}
                          onCancel={() => setPromoting(null)}
                          onSubmit={onPromote}
                        />
                      ),
                    }
                  : null
              }
              onSave={(text) => run(() => updatePersonal(p.personalQuestionId, text))}
              onDelete={() => {
                if (window.confirm("Delete this question?")) void run(() => deletePersonal(p.personalQuestionId));
              }}
            />
          ))}
        </ul>
        <div className="mt-3">
          <label className="block text-sm">
            <span className="font-medium">Save a new question</span>
            <textarea className={FIELD} rows={2} maxLength={1000} value={draft} onChange={(e) => setDraft(e.target.value)} />
          </label>
          <Button size="sm"
            className="mt-2"
            disabled={busy || draft.trim().length === 0}
            onClick={() => {
              void run(() => createPersonal(draft.trim())).then((ok) => {
                if (ok) setDraft("");
              });
            }}
          >
            Add question
          </Button>
        </div>
      </section>
    </div>
  );
}

/** Pure, for tests: the shared library grouped by section. `action` is the admin's promote button, or nothing. */
export function SharedLibraryTable({ library, action = null }: { library: LibraryQuestionView[]; action?: React.ReactNode }) {
  return (
    <section className="card p-0">
      <div className="px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="eyebrow text-[var(--muted)]">Shared questions ({library.length})</h2>
          {action}
        </div>
        <p className="mt-2 text-sm text-[var(--muted)]">
          <span className="font-medium">computed</span> questions are answered by code over the points named;{" "}
          <span className="font-medium">planner</span> questions by the Analyze planner. A question runs only
          when every point it needs is trended for at least the coverage shown.
        </p>
      </div>
      <div className="max-h-[36rem] overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left text-[var(--muted)]">
            <tr>
              <th className="eyebrow px-5 py-2.5 text-[var(--muted)]">#</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Question</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Kind</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Applies to</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Points required</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Coverage</th>
              <th className="eyebrow py-2.5 pr-5 text-[var(--muted)]">Enabled</th>
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
                      <span className="inline-block rounded-full border border-[var(--border)] px-2 py-0.5 text-[0.6875rem]">{q.kind}</span>
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
  promote,
  onSave,
  onDelete,
}: {
  question: PersonalQuestionView;
  busy: boolean;
  /** A module admin's promotion control for this row; null for everyone else. */
  promote: { open: boolean; onOpen: () => void; form: React.ReactNode } | null;
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
          <Button size="sm"  disabled={busy || text.trim().length === 0} onClick={() => void onSave(text.trim()).then((ok) => ok && setEditing(false))}>
            Save
          </Button>
          <Button size="sm"  disabled={busy} onClick={() => { setText(question.text); setEditing(false); }}>
            Cancel
          </Button>
        </div>
      </li>
    );
  }

  if (promote !== null && promote.open) {
    return (
      <li className="px-3 py-3 text-sm">
        <p className="font-medium">{question.text}</p>
        {promote.form}
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
        {promote !== null && (
          <Button size="sm" disabled={busy} onClick={promote.onOpen}>
            Promote to shared
          </Button>
        )}
        <Button size="sm"  disabled={busy} onClick={() => setEditing(true)}>Edit</Button>
        <Button size="sm"  disabled={busy || question.usedInReports > 0} title={question.usedInReports > 0 ? "Remove it from the reports that use it first." : undefined} onClick={onDelete}>
          Delete
        </Button>
      </span>
    </li>
  );
}

/**
 * The promotion form (Phase 6): which of the admin's questions (when there
 * is more than one to pick from), its section, the equipment types it
 * applies to (none ticked: the whole building) and the point roles it needs
 * (each one required). A question with neither is always put to the
 * planner; one with either is judged against the building first, and a
 * building without them reads Not applicable or Not monitored at no cost.
 */
export function PromoteForm({
  options,
  personal,
  busy,
  onCancel,
  onSubmit,
}: {
  options: PromotionOptions;
  personal: PersonalQuestionView[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: Parameters<typeof promoteQuestion>[0], text: string) => Promise<boolean>;
}) {
  const [questionId, setQuestionId] = useState(personal[0]?.personalQuestionId ?? "");
  const [section, setSection] = useState(options.sections[0]?.key ?? "");
  const [types, setTypes] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [roleFilter, setRoleFilter] = useState("");
  const visibleRoles = useMemo(() => {
    const term = roleFilter.trim().toLowerCase();
    return term === "" ? options.roles : options.roles.filter((r) => r.label.toLowerCase().includes(term) || r.key.includes(term));
  }, [options.roles, roleFilter]);
  const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  const chosen = personal.find((p) => p.personalQuestionId === questionId) ?? null;

  return (
    <div className="mt-3 space-y-3">
      {personal.length > 1 && (
        <label className="block text-sm">
          <span className="font-medium">Question</span>
          <select className={FIELD} value={questionId} onChange={(e) => setQuestionId(e.target.value)}>
            {personal.map((p) => (
              <option key={p.personalQuestionId} value={p.personalQuestionId}>
                {p.text}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block text-sm">
        <span className="font-medium">Section</span>
        <select className={FIELD} value={section} onChange={(e) => setSection(e.target.value)}>
          {options.sections.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="text-sm">
        <legend className="font-medium">Applies to</legend>
        <p className="text-xs text-[var(--muted)]">None ticked: the whole building. Ticked: a building with none of these reads Not applicable.</p>
        <div className="mt-1 flex max-h-32 flex-wrap gap-x-4 gap-y-1 overflow-auto">
          {options.equipmentTypes.map((t) => (
            <label key={t.key} className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={types.includes(t.key)} onChange={() => setTypes(toggle(types, t.key))} />
              {t.label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="text-sm">
        <legend className="font-medium">Points required{roles.length > 0 ? ` (${roles.length})` : ""}</legend>
        <p className="text-xs text-[var(--muted)]">Each ticked role is required. A building that does not trend one reads Not monitored and the planner is not asked.</p>
        <input className={FIELD} placeholder="Filter roles" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Filter roles" />
        <div className="mt-1 flex max-h-40 flex-wrap gap-x-4 gap-y-1 overflow-auto">
          {visibleRoles.map((r) => (
            <label key={r.key} className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={roles.includes(r.key)} onChange={() => setRoles(toggle(roles, r.key))} />
              {r.label}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-xs text-[var(--muted)]">
        It joins the shared questions as a <span className="font-medium">planner</span> question, answered by the Analyze planner on every report that ticks it. Your
        own copy stays in your library.
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || chosen === null || section === ""}
          onClick={() => {
            if (chosen === null) return;
            void onSubmit({ personalQuestionId: chosen.personalQuestionId, section, appliesToEquipment: types, requiredRoles: roles }, chosen.text);
          }}
        >
          Add to shared questions
        </Button>
        <Button size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

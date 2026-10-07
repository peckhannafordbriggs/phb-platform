"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from "lucide-react";
import type { WorkflowStatus, WorkflowView } from "@/lib/modules/cost-intelligence/workflows";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Dropdown } from "../ui/Dropdown";
import { Pill, type PillTone } from "../ui/Pill";

const API = "/api/modules/cost-intelligence/workflows";
const PAGE = "/cost-intelligence/settings/workflows";

const STATUS_LABEL: Record<WorkflowStatus, string> = { draft: "Draft", active: "Active", paused: "Paused" };
const STATUS_TONE: Record<WorkflowStatus, PillTone> = { draft: "draft", active: "ok", paused: "muted" };

/** The one status change each status offers. Mirrors NEXT_STATUS in the service. */
const NEXT: Record<WorkflowStatus, { label: string; to: WorkflowStatus }> = {
  draft: { label: "Activate", to: "active" },
  active: { label: "Pause", to: "paused" },
  paused: { label: "Resume", to: "active" },
};

const UPDATED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
});

const INPUT =
  "w-full rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3 py-2 text-[0.8125rem] focus:border-[var(--module-accent)] focus:outline-none";

export type CatalogOption = { folderName: string; name: string; version: number };
export type WorkflowListItem = { id: string; name: string; status: WorkflowStatus };

type Outcome = { ok: true; data: unknown } | { ok: false; message: string };

/** Every write goes through here, so every screen reads errors the same way. */
async function send(url: string, method: string, body?: unknown): Promise<Outcome> {
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as
      | { data?: unknown; error?: { message: string } }
      | null;
    if (!response.ok) return { ok: false, message: json?.error?.message ?? "That did not work. Try again." };
    return { ok: true, data: json?.data };
  } catch {
    return { ok: false, message: "Could not reach the server. Try again." };
  }
}

function ErrorLine({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p role="alert" className="text-[0.75rem] text-[var(--phb-orange-ink)]">
      {message}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Left: the list, and New workflow
// ---------------------------------------------------------------------------

/**
 * Each workflow is its own URL, like the skills list: picking one re-renders the
 * page, `scroll={false}` keeps the page still and the selected row is scrolled
 * back into view.
 */
export function WorkflowList({ workflows, selected }: { workflows: WorkflowListItem[]; selected: string | null }) {
  const router = useRouter();
  const selectedRef = useRef<HTMLAnchorElement>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function close() {
    setCreating(false);
    setName("");
    setError(null);
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await send(API, "POST", { name });
    setBusy(false);
    if (!result.ok) return setError(result.message);
    close();
    router.push(`${PAGE}/${(result.data as { id: string }).id}`, { scroll: false });
  }

  return (
    <>
      <div className="shrink-0 border-b border-[var(--divider-soft)] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="eyebrow whitespace-nowrap text-[var(--muted)]">Workflows · {workflows.length}</span>
          {!creating && (
            <Button onClick={() => setCreating(true)}>
              <Plus size={14} aria-hidden="true" />
              New workflow
            </Button>
          )}
        </div>
        {creating && (
          <form onSubmit={create} className="mt-3 flex flex-col gap-2">
            <input
              autoFocus
              aria-label="Workflow name"
              placeholder="Workflow name"
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && close()}
              className={INPUT}
            />
            <ErrorLine message={error} />
            <div className="flex justify-end gap-2">
              <Button onClick={close}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={busy || name.trim().length === 0}>
                {busy ? "Creating…" : "Create draft"}
              </Button>
            </div>
          </form>
        )}
      </div>

      {workflows.length === 0 ? (
        <p className="px-5 py-6 text-[0.8125rem] text-[var(--muted)]">No workflows yet.</p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {workflows.map((w) => {
            const isSelected = w.id === selected;
            return (
              <li key={w.id}>
                <Link
                  ref={isSelected ? selectedRef : undefined}
                  href={`${PAGE}/${w.id}`}
                  scroll={false}
                  aria-current={isSelected ? "page" : undefined}
                  className={
                    "flex items-center justify-between gap-3 rounded-[var(--radius-control)] px-3 py-1.5 text-[0.8125rem] transition-colors " +
                    (isSelected
                      ? "bg-[color-mix(in_srgb,var(--module-accent)_16%,transparent)] font-semibold text-[var(--module-accent-ink)]"
                      : "text-[var(--foreground)] hover:bg-[var(--neutral-100)]")
                  }
                >
                  <span className="truncate">{w.name}</span>
                  <Pill tone={STATUS_TONE[w.status]}>{STATUS_LABEL[w.status]}</Pill>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Right: one workflow
// ---------------------------------------------------------------------------

/**
 * Every change is saved as soon as it is made, then the page re-renders from the
 * database. Nothing is kept here that the server has not accepted, so there is
 * no unsaved state to lose. Keyed by workflow id, so switching resets it.
 */
export function WorkflowEditor({ workflow, skills }: { workflow: WorkflowView; skills: CatalogOption[] }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description ?? "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const busy = saving || refreshing;
  const url = `${API}/${workflow.id}`;
  const folders = workflow.steps.map((s) => s.folderName);
  const missing = workflow.steps.filter((s) => s.missing).length;
  const next = NEXT[workflow.status];
  const blocked =
    next.to !== "active"
      ? null
      : workflow.steps.length === 0
        ? "Add at least one skill to activate."
        : missing > 0
          ? "Remove the missing skills to activate."
          : null;

  /** Runs one write. On success re-renders from the server; returns whether it worked. */
  async function save(call: Promise<Outcome>): Promise<boolean> {
    setSaving(true);
    setError(null);
    const result = await call;
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    startRefresh(() => router.refresh());
    return true;
  }

  const setSteps = (next: string[]) => save(send(`${url}/steps`, "PUT", { steps: next }));

  function move(index: number, by: -1 | 1) {
    const next = [...folders];
    const [step] = next.splice(index, 1);
    if (step === undefined) return;
    next.splice(index + by, 0, step);
    void setSteps(next);
  }

  function startEdit() {
    setName(workflow.name);
    setDescription(workflow.description ?? "");
    setEditing(true);
  }

  async function saveDetails(event: React.FormEvent) {
    event.preventDefault();
    if (await save(send(url, "PATCH", { name, description }))) setEditing(false);
  }

  async function remove() {
    setSaving(true);
    setError(null);
    const result = await send(url, "DELETE");
    setSaving(false);
    if (!result.ok) return setError(result.message);
    router.push(PAGE, { scroll: false });
    router.refresh();
  }

  const addable = skills
    .filter((s) => !folders.includes(s.folderName))
    .map((s) => ({ value: s.folderName, label: `${s.name} · v${s.version}` }));

  return (
    <Card padding="p-0" className="min-h-0 overflow-y-auto">
      <div className="flex flex-col gap-6 px-6 py-5">
        {/* Header: name, description, status and its actions */}
        {editing ? (
          <form onSubmit={saveDetails} className="flex flex-col gap-3">
            <input
              autoFocus
              aria-label="Workflow name"
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={INPUT + " text-base font-semibold"}
            />
            <textarea
              aria-label="Description"
              placeholder="What this workflow is for (optional)"
              maxLength={2000}
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={INPUT + " resize-y"}
            />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setEditing(false)}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={busy || name.trim().length === 0}>
                Save
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2.5">
                <h2 className="truncate text-xl font-semibold">{workflow.name}</h2>
                <Pill tone={STATUS_TONE[workflow.status]}>{STATUS_LABEL[workflow.status]}</Pill>
                <button
                  type="button"
                  onClick={startEdit}
                  aria-label="Edit name and description"
                  className="rounded p-1 text-[var(--muted)] hover:bg-[var(--neutral-100)] hover:text-[var(--foreground)]"
                >
                  <Pencil size={14} aria-hidden="true" />
                </button>
              </div>
              <p className="mt-1 text-[0.8125rem] text-[var(--muted)]">
                {workflow.description ?? "No description."}
              </p>
              <p className="mt-1 text-[0.75rem] text-[var(--muted)]">Updated {UPDATED.format(workflow.updatedAt)}</p>
            </div>

            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <div className="flex gap-2">
                {workflow.status === "draft" &&
                  (confirmingDelete ? (
                    <>
                      <Button onClick={() => setConfirmingDelete(false)}>Keep</Button>
                      <Button variant="primary" onClick={remove} disabled={busy}>
                        Delete draft
                      </Button>
                    </>
                  ) : (
                    <Button onClick={() => setConfirmingDelete(true)} disabled={busy}>
                      <Trash2 size={14} aria-hidden="true" />
                      Delete
                    </Button>
                  ))}
                {!confirmingDelete && (
                  <Button
                    variant={next.to === "active" ? "primary" : "secondary"}
                    disabled={busy || blocked !== null}
                    onClick={() => void save(send(url, "PATCH", { status: next.to }))}
                  >
                    {next.label}
                  </Button>
                )}
              </div>
              {blocked && <p className="text-[0.75rem] text-[var(--muted)]">{blocked}</p>}
            </div>
          </div>
        )}

        <ErrorLine message={error} />

        {/* Steps */}
        <div>
          <p className="eyebrow mb-3 text-[var(--muted)]">Steps · run in order</p>
          {workflow.steps.length === 0 ? (
            <p className="mb-3 text-[0.8125rem] text-[var(--muted)]">No skills yet. Add the first one below.</p>
          ) : (
            <ol className="mb-3 flex flex-col gap-2">
              {workflow.steps.map((s, i) => (
                <li
                  key={s.folderName}
                  className="flex items-center gap-4 rounded-[var(--radius-row)] border border-[var(--border)] bg-white px-4 py-2.5"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--neutral-100)] text-[0.75rem] font-semibold">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[0.875rem] font-medium">{s.name ?? s.folderName}</p>
                    <p className="truncate font-mono text-[0.75rem] text-[var(--muted)]">{s.folderName}</p>
                  </div>
                  {s.missing ? (
                    <Pill tone="warn">Missing from catalog</Pill>
                  ) : (
                    <span className="shrink-0 font-mono text-[0.6875rem] text-[var(--muted)]">v{s.version}</span>
                  )}
                  <div className="flex shrink-0 items-center">
                    <IconButton label={`Move ${s.folderName} up`} disabled={busy || i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp size={14} aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      label={`Move ${s.folderName} down`}
                      disabled={busy || i === workflow.steps.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown size={14} aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      label={`Remove ${s.folderName}`}
                      disabled={busy || (workflow.steps.length === 1 && workflow.status !== "draft")}
                      onClick={() => void setSteps(folders.filter((f) => f !== s.folderName))}
                    >
                      <X size={14} aria-hidden="true" />
                    </IconButton>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {addable.length > 0 ? (
            <Dropdown
              label="Add a skill"
              placeholder="Add a skill…"
              value=""
              options={addable}
              onChange={(folder) => !busy && void setSteps([...folders, folder])}
              className="max-w-sm"
            />
          ) : (
            <p className="text-[0.75rem] text-[var(--muted)]">Every skill in the catalog is already in this workflow.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1.5 text-[var(--muted)] hover:bg-[var(--neutral-100)] hover:text-[var(--foreground)] disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

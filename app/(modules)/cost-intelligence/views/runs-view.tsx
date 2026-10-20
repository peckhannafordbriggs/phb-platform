"use client";

import { useEffect, useState, useTransition } from "react";
import { ArrowUpRight, FileText, MessageSquare, Paperclip, X } from "lucide-react";
import { useRouter } from "next/navigation";
import type { LaunchOption, RunDetail, RunListItem, RunStatus } from "@/lib/modules/cost-intelligence/runs";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Dropdown } from "../ui/Dropdown";
import { FilterMenu } from "../ui/FilterMenu";
import { Label } from "../ui/Label";
import { Pill, type PillTone } from "../ui/Pill";
import { Table } from "../ui/Table";

const API = "/api/modules/cost-intelligence/runs";

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting on you",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
const STATUS_TONE: Record<RunStatus, PillTone> = {
  queued: "muted",
  running: "draft",
  waiting: "warn",
  succeeded: "ok",
  failed: "warn",
  cancelled: "muted",
};
const ACTIVE: RunStatus[] = ["queued", "running", "waiting"];

const WHEN = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
});
const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

const money = (usd: number) => `$${usd.toFixed(2)}`;

export function StatusPill({ status }: { status: RunStatus }) {
  return <Pill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>;
}

/** POST to the runs API; returns the data or a message to show. */
async function post(url: string, body: unknown): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as { data?: unknown; error?: { message: string } } | null;
    if (!response.ok) return { ok: false, message: json?.error?.message ?? "That did not work. Try again." };
    return { ok: true, data: json?.data };
  } catch {
    return { ok: false, message: "Could not reach the server. Try again." };
  }
}

/** Re-reads the page from the server every few seconds while `active`. */
function useLiveRefresh(active: boolean, everyMs = 4000) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs, router]);
}

// ---------------------------------------------------------------------------
// Runs page: the launcher, the list, the selected run
// ---------------------------------------------------------------------------

/** The runs list beside the selected run, and New run's launcher when `options` is given. */
export function RunsView({
  runs,
  options,
}: {
  runs: RunListItem[];
  options: { workflows: LaunchOption[]; projects: LaunchOption[] } | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [project, setProject] = useState("");
  useLiveRefresh(runs.some((r) => ACTIVE.includes(r.status)));

  const projects = [...new Set(runs.map((r) => r.projectName))].sort().map((p) => ({ value: p, label: p }));
  const shown = project ? runs.filter((r) => r.projectName === project) : runs;
  // Newest first, so with nothing picked (or the pick filtered out) show the latest.
  const selected = shown.find((r) => r.id === selectedId) ?? shown[0] ?? null;

  return (
    <div className="flex flex-col gap-5">
      {options && (
        <div className="mx-auto w-full max-w-3xl">
          <RunLauncher options={options} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Card>
          {runs.length === 0 ? (
            <p className="text-[0.8125rem] text-[var(--muted)]">No runs yet. Press New run to start one.</p>
          ) : (
            <Table
              headers={[
                <span key="project" className="inline-flex items-center gap-1">
                  Project
                  <FilterMenu
                    label="project"
                    options={[{ value: "", label: "All projects" }, ...projects]}
                    value={project}
                    onChange={setProject}
                  />
                </span>,
                "Workflow",
                "Status",
                "Started",
              ]}
              rows={shown.map((r) => [r.projectName, r.workflowName, <StatusPill key={r.id} status={r.status} />, WHEN.format(r.createdAt)])}
              pageSize={8}
              onRowClick={(i) => setSelectedId(shown[i]?.id ?? null)}
              selected={selected ? shown.findIndex((r) => r.id === selected.id) : undefined}
            />
          )}
        </Card>
        <RunSummary run={selected} />
      </div>
    </div>
  );
}

function RunSummary({ run }: { run: RunListItem | null }) {
  if (!run) {
    return (
      <Card>
        <p className="text-[0.8125rem] text-[var(--muted)]">Select a run to see its details.</p>
      </Card>
    );
  }
  return (
    <Card className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <span className="eyebrow text-[var(--muted)]">Run {run.id}</span>
        <StatusPill status={run.status} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <h2 className="min-w-0 truncate text-lg font-medium">{run.projectName}</h2>
        <Button href={`/cost-intelligence/runs/${run.id}`}>
          Open run
          <ArrowUpRight size={16} aria-hidden="true" />
        </Button>
      </div>
      <dl className="grid grid-cols-3 gap-4 border-t border-[var(--divider-soft)] pt-4 text-[0.8125rem]">
        <div>
          <dt className="text-[var(--muted)]">Workflow</dt>
          <dd>{run.workflowName}</dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">Started</dt>
          <dd>{WHEN.format(run.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">Cost</dt>
          <dd>{money(run.costUsd)}</dd>
        </div>
      </dl>
    </Card>
  );
}

/** "Run [workflow] on [project]". Busy projects are listed but refused, with the reason. */
/**
 * MOCKUP: attach files and leave a note for the run. Nothing is uploaded or
 * sent with the run yet; the note stays in the browser. TODO(backend).
 */
function RunNotes() {
  const [note, setNote] = useState("");
  return (
    <div className="mt-3 flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-2 focus-within:border-[var(--module-accent)]">
      <button
        type="button"
        aria-label="Attach files"
        title="Attach files"
        className="rounded p-1 text-[var(--muted)] hover:bg-[var(--neutral-50)] hover:text-[var(--foreground)]"
      >
        <Paperclip size={14} aria-hidden="true" />
      </button>
      <MessageSquare size={14} aria-hidden="true" className="shrink-0 text-[var(--muted)]" />
      <input
        type="text"
        aria-label="Note for this run"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Add a note or instructions for this run (optional)"
        className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-[var(--foreground)] outline-none placeholder:text-[var(--muted)]"
      />
    </div>
  );
}

function RunLauncher({ options }: { options: { workflows: LaunchOption[]; projects: LaunchOption[] } }) {
  const router = useRouter();
  const [workflow, setWorkflow] = useState("");
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    const result = await post(API, { workflowId: workflow, projectId: project });
    setBusy(false);
    if (!result.ok) return setError(result.message);
    router.push(`/cost-intelligence/runs/${(result.data as { id: string }).id}`);
  }

  if (options.workflows.length === 0 || options.projects.length === 0) {
    return (
      <Card>
        <p className="text-[0.8125rem] text-[var(--muted)]">
          {options.workflows.length === 0
            ? "No active workflows yet. A PCE activates one in Settings → Workflows."
            : "No projects yet. A PCE syncs them in Settings → Projects."}
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        Run
        <Dropdown
          label="Workflow"
          placeholder="Choose a workflow"
          options={options.workflows}
          value={workflow}
          onChange={setWorkflow}
          className="min-w-40 flex-1"
        />
        on
        <Dropdown
          label="Project"
          placeholder="Choose a project"
          options={options.projects.map((p) => ({ value: p.value, label: p.busy ? `${p.label} (run going)` : p.label }))}
          value={project}
          onChange={setProject}
          className="min-w-40 flex-1"
        />
        <Button variant="primary" onClick={start} disabled={busy || !workflow || !project}>
          {busy ? "Starting…" : "Start run"}
        </Button>
      </div>
      <RunNotes />
      {error && (
        <p role="alert" className="mt-3 text-[0.75rem] text-[var(--phb-orange-ink)]">
          {error}
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Run page: the monitor
// ---------------------------------------------------------------------------

const STEP_COLOR = {
  done: "var(--neutral-600)",
  current: "var(--module-accent)",
  pending: "var(--neutral-300)",
  failed: "var(--phb-orange)",
} as const;

/** A diamond node, as on the step timeline and the ledger. */
function Node({ color, filled = false }: { color: string; filled?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={"diamond" + (filled ? " diamond--filled" : "")}
      style={{ width: 10, height: 10, color }}
    />
  );
}

/** One run: header, ledger with the open question, skill steps, cost and outputs. Live while active. */
export function RunMonitor({ run }: { run: RunDetail }) {
  const router = useRouter();
  const active = ACTIVE.includes(run.status);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLiveRefresh(active && run.status !== "waiting");

  async function cancel() {
    setCancelling(true);
    const result = await post(`${API}/${run.id}`, { action: "cancel" });
    setCancelling(false);
    if (!result.ok) return setError(result.message);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <div className="flex items-center justify-between gap-3">
          <span className="eyebrow text-[var(--muted)]">Run {run.id}</span>
          <div className="flex items-center gap-2">
            <StatusPill status={run.status} />
            {active && (
              <Button onClick={cancel} disabled={cancelling}>
                <X size={14} aria-hidden="true" />
                {cancelling ? "Cancelling…" : "Cancel run"}
              </Button>
            )}
          </div>
        </div>
        <h2 className="mt-2 text-lg font-medium">{run.projectName}</h2>
        {error && <p className="mt-2 text-[0.75rem] text-[var(--phb-orange-ink)]">{error}</p>}
        {run.error && <p className="mt-2 text-[0.8125rem] text-[var(--phb-orange-ink)]">{run.error}</p>}
        <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-[var(--divider-soft)] pt-4 text-[0.8125rem] sm:grid-cols-4">
          <div>
            <dt className="text-[var(--muted)]">Workflow</dt>
            <dd>{run.workflowName}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Started</dt>
            <dd>
              {WHEN.format(run.createdAt)}
              {run.startedBy && <span className="text-[var(--muted)]"> by {run.startedBy}</span>}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Finished</dt>
            <dd>{run.finishedAt ? WHEN.format(run.finishedAt) : "Not yet"}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Model</dt>
            <dd className="font-mono text-[0.75rem]">{run.model}</dd>
          </div>
        </dl>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <Label>Run ledger</Label>
          {run.events.length === 0 ? (
            <p className="text-[0.8125rem] text-[var(--muted)]">Nothing recorded yet.</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {run.events.map((e) => (
                <li key={e.id} className="flex items-start gap-3 text-[0.8125rem]">
                  <span className="w-16 shrink-0 text-[var(--muted)]">{TIME.format(e.at)}</span>
                  <span className="mt-1">
                    <Node color={e.type === "failed" ? STEP_COLOR.failed : "var(--neutral-600)"} />
                  </span>
                  <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{e.message}</p>
                </li>
              ))}
            </ol>
          )}
          {run.checkpoint && run.status === "waiting" && (
            <div className="mt-5">
              <CheckpointForm runId={run.id} checkpoint={run.checkpoint} />
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <Label>Skills · run in order</Label>
            <ol className="flex flex-col">
              {run.steps.map((s, i) => (
                <li
                  key={`${s.folderName}-${i}`}
                  aria-current={s.state === "current" ? "step" : undefined}
                  className={
                    "flex items-center gap-3 py-1.5 text-[0.8125rem] " +
                    (s.state === "pending" ? "text-[var(--muted)]" : "") +
                    (s.state === "current" ? " font-medium" : "")
                  }
                >
                  <Node color={STEP_COLOR[s.state]} filled={s.state === "done"} />
                  <span className="flex-1 truncate">{s.name}</span>
                  <span className="font-mono text-[0.6875rem] text-[var(--muted)]">v{s.version}</span>
                </li>
              ))}
            </ol>
            <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-[var(--divider-soft)] pt-4 text-[0.8125rem]">
              <div>
                <dt className="text-[var(--muted)]">Tokens</dt>
                <dd className="mt-1 text-lg font-medium">{run.tokens.toLocaleString("en-US")}</dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Cost</dt>
                <dd className="mt-1 text-lg font-medium">{money(run.costUsd)}</dd>
                <dd className="text-[0.6875rem] text-[var(--muted)]">cap {money(run.budgetUsd)}</dd>
              </div>
            </dl>
          </Card>
          <Card>
            <Label>Outputs · AI FILES</Label>
            {run.outputs.length === 0 ? (
              <p className="text-[0.8125rem] text-[var(--muted)]">None yet.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-[0.8125rem]">
                {run.outputs.map((o) => (
                  <li key={o.path} className="flex items-center gap-2">
                    <FileText size={14} aria-hidden="true" className="shrink-0 text-[var(--muted)]" />
                    <span className="truncate">{o.path}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/** The skill's question: pick an option, or type an answer. Answering resumes the run. */
function CheckpointForm({
  runId,
  checkpoint,
}: {
  runId: string;
  checkpoint: NonNullable<RunDetail["checkpoint"]>;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState("");
  const [other, setOther] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const answer = choice === "__other" || checkpoint.options.length === 0 ? other : choice;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const result = await post(`${API}/${runId}`, { action: "answer", answer });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    startRefresh(() => router.refresh());
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-[var(--radius-row)] border border-[var(--module-accent)] bg-[color-mix(in_srgb,var(--module-accent)_6%,white)] p-4"
    >
      <p className="eyebrow text-[var(--muted)]">The run needs your answer</p>
      <p className="mt-2 whitespace-pre-wrap text-[0.875rem] font-medium">{checkpoint.question}</p>
      <div className="mt-3 flex flex-col gap-2">
        {checkpoint.options.map((o) => (
          <label key={o} className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-control)] border border-[var(--border)] bg-white p-3 text-[0.8125rem]">
            <input type="radio" name="answer" value={o} checked={choice === o} onChange={() => setChoice(o)} className="mt-0.5" />
            <span>{o}</span>
          </label>
        ))}
        {checkpoint.options.length > 0 && (
          <label className="flex cursor-pointer items-center gap-3 rounded-[var(--radius-control)] border border-[var(--border)] bg-white p-3 text-[0.8125rem]">
            <input type="radio" name="answer" value="__other" checked={choice === "__other"} onChange={() => setChoice("__other")} />
            <span>Something else</span>
          </label>
        )}
        {(choice === "__other" || checkpoint.options.length === 0) && (
          <textarea
            aria-label="Your answer"
            rows={3}
            value={other}
            onChange={(e) => setOther(e.target.value)}
            className="w-full rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3 py-2 text-[0.8125rem] focus:border-[var(--module-accent)] focus:outline-none"
          />
        )}
      </div>
      {error && <p className="mt-2 text-[0.75rem] text-[var(--phb-orange-ink)]">{error}</p>}
      <Button type="submit" variant="primary" className="mt-4" disabled={saving || refreshing || answer.trim().length === 0}>
        {saving || refreshing ? "Resuming…" : "Answer and resume"}
      </Button>
      <p className="mt-2 text-[0.75rem] text-[var(--muted)]">
        Answering restarts the agent, which costs money. To end the run instead, use Cancel run.
      </p>
    </form>
  );
}

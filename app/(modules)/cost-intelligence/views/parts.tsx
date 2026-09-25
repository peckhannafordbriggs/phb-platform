import { Bar } from "../ui/Bar";
import { Card } from "../ui/Card";
import { Label } from "../ui/Label";
import { Table } from "../ui/Table";

export type Run = {
  id: string;
  job: string;
  workflow: string;
  status: string;
  started: string;
};

/** A diamond node, as on the skill pipeline and the step timeline. */
export function Node({ size = 10 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="diamond"
      style={{ width: size, height: size, color: "var(--neutral-300)" }}
    />
  );
}

/** The seven-step run timeline: node, step name, time. */
export function Timeline() {
  return (
    <div className="flex flex-col">
      {[34, 42, 30, 48, 52, 44, 36].map((w, i) => (
        <div key={i} className="flex items-center gap-3 py-1.5">
          <Node />
          <Bar w={`${w}%`} h={9} />
          <div className="flex-1" />
          <Bar w={34} h={8} />
        </div>
      ))}
    </div>
  );
}

/** A paused-run checkpoint: the question, its context, and the options to pick from. */
export function Checkpoint({ options = 3, columns = false }: { options?: number; columns?: boolean }) {
  return (
    <div className="rounded-[var(--radius-row)] border border-dashed border-[var(--neutral-300)] bg-[var(--neutral-50)] p-4">
      <Bar w={150} h={8} />
      <Bar w="85%" h={14} className="mt-3" />
      <Bar w="60%" h={14} className="mt-2" />
      <Bar w="95%" h={8} className="mt-3" />
      <Bar w="80%" h={8} className="mt-1.5" />
      <div className={"mt-4 gap-2 " + (columns ? "grid grid-cols-3" : "flex flex-col")}>
        {Array.from({ length: options }, (_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-[var(--radius-control)] border border-[var(--border)] bg-white p-3">
            <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-[var(--neutral-300)]" />
            <div className="flex-1">
              <Bar w="70%" h={9} />
              <Bar w="45%" h={7} className="mt-1.5" />
            </div>
          </div>
        ))}
      </div>
      <Bar w={130} h={30} className="mt-4" />
    </div>
  );
}

/** Run detail: the selected run's job, workflow, status and start time. */
export function RunDetail({ selectedRun }: { selectedRun: Run | null }) {
  if (!selectedRun) {
    return (
      <Card>
        <p className="text-[0.8125rem] text-[var(--muted)]">Select a run to see its details.</p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <span className="eyebrow text-[var(--muted)]">{selectedRun.id}</span>
        <span className="text-[0.8125rem]">{selectedRun.status}</span>
      </div>
      <h2 className="text-lg font-medium text-[var(--foreground)]">{selectedRun.job}</h2>
      <dl className="grid grid-cols-2 gap-4 border-t border-[var(--divider-soft)] pt-4 text-[0.8125rem]">
        <div>
          <dt className="text-[var(--muted)]">Workflow</dt>
          <dd>{selectedRun.workflow}</dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">Started</dt>
          <dd>{selectedRun.started}</dd>
        </div>
      </dl>
    </Card>
  );
}

/** The runs list. Clicking a row selects that run. */
export function RunHistory({
  runs,
  selectedRun,
  setSelectedRun,
}: {
  runs: Run[];
  selectedRun: Run | null;
  setSelectedRun: (run: Run) => void;
}) {
  return (
    <Card>
      {runs.length === 0 ? (
        <p className="text-[0.8125rem] text-[var(--muted)]">No runs yet.</p>
      ) : (
        <Table
          headers={["Job", "Workflow", "Status", "Started"]}
          rows={runs.map((r) => [r.job, r.workflow, r.status, r.started])}
          pageSize={8}
          onRowClick={(i) => {
            const run = runs[i];
            if (run) setSelectedRun(run);
          }}
          selected={selectedRun ? runs.findIndex((r) => r.id === selectedRun.id) : undefined}
        />
      )}
    </Card>
  );
}

/** A file row: type badge, name, meta. */
export function FileRow() {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="h-7 w-7 shrink-0 rounded-md bg-[var(--neutral-100)]" />
      <div className="flex-1">
        <Bar w="70%" h={9} />
        <Bar w="35%" h={7} className="mt-1.5" />
      </div>
    </div>
  );
}

export { Label };

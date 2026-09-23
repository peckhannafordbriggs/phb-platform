import { Bar, Card, Label, Rows } from "../skeleton";

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
    <Rows
      n={7}
      gap="gap-0"
      row={(i) => (
        <div className="flex items-center gap-3 py-1.5">
          <Node />
          <Bar w={`${[34, 42, 30, 48, 52, 44, 36][i]}%`} h={9} />
          <div className="flex-1" />
          <Bar w={34} h={8} />
        </div>
      )}
    />
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

/** Run detail: meta, title, pinned skills, timeline, checkpoint, footer. */
export function RunDetail() {
  return (
    <Card className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <Bar w={120} h={8} />
        <Bar w={110} h={22} />
      </div>
      <div>
        <Bar w="65%" h={18} />
        <div className="mt-3 flex gap-2">
          <Bar w={170} h={20} />
          <Bar w={100} h={20} />
        </div>
        <Bar w={80} h={8} className="mt-3" />
      </div>
      <Timeline />
      <Checkpoint />
      <div className="flex items-center justify-between border-t border-[var(--divider-soft)] pt-4">
        <Bar w={160} h={8} />
        <Bar w={70} h={8} />
      </div>
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

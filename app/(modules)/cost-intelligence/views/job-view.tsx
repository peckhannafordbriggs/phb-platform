import { Bar, Button, Card, Label, Rows } from "../skeleton";
import { Checkpoint, FileRow, Node } from "./parts";

/** 1b: the job is the page. Skills on a track, memory and files beside what is waiting on you. */
export function JobView() {
  return (
    <div className="flex flex-col gap-5">
      <Card className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-4 p-6">
          <div>
            <Bar w={170} h={8} />
            <div className="mt-3 flex items-center gap-3">
              <Bar w={90} h={26} />
              <Bar w={280} h={22} />
            </div>
            <Bar w={320} h={9} className="mt-3" />
          </div>
          <div className="flex gap-2">
            <Button w={104} />
            <Button w={112} filled />
          </div>
        </div>

        <div className="border-t border-[var(--divider-soft)] p-6">
          <Label>Skill pipeline</Label>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex flex-col items-center gap-2.5 rounded-[var(--radius-row)] p-4">
                <div className="flex w-full items-center">
                  <div className="h-px flex-1 bg-[var(--neutral-200)]" />
                  <Node size={22} />
                  <div className="h-px flex-1 bg-[var(--neutral-200)]" />
                </div>
                <Bar w="60%" h={11} />
                <Bar w="80%" h={8} />
                <Bar w="45%" h={8} />
              </div>
            ))}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Card>
          <div className="flex items-center justify-between">
            <Label>Stage</Label>
            <Bar w={120} h={22} />
          </div>
          <Bar w="60%" h={16} />
          <Bar w="95%" h={8} className="mt-3" />
          <Bar w="80%" h={8} className="mt-1.5" />
          <Bar w="100%" h={6} className="mt-5" />
          <Rows
            n={3}
            gap="gap-2.5"
            row={() => (
              <div className="mt-4 flex justify-between">
                <Bar w="45%" h={8} />
                <Bar w={40} h={8} />
              </div>
            )}
          />
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <Label>Job memory</Label>
            <div className="grid grid-cols-2 gap-2">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="rounded-[var(--radius-control)] border border-[var(--border)] p-3">
                  <Bar w="50%" h={7} />
                  <Bar w="80%" h={10} className="mt-2" />
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <Label>Files</Label>
            <Rows n={5} gap="gap-0" row={() => <FileRow />} />
          </Card>
        </div>

        <Card>
          <div className="flex items-center justify-between">
            <Label>Waiting on you</Label>
            <Bar w={60} h={8} />
          </div>
          <Checkpoint />
        </Card>
      </div>
    </div>
  );
}

/** Jobs you can open: a grid of job cards. */
export function JobsView() {
  return (
    <div className="flex flex-col gap-5">
      <div className="h-10 w-80 rounded-[var(--radius-control)] border border-[var(--border)] bg-white" />
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Card key={i}>
            <div className="flex items-center gap-3">
              <Bar w={56} h={14} />
              <Bar w="55%" h={14} />
            </div>
            <Bar w="75%" h={8} className="mt-3" />
            <div className="mt-5 flex items-center justify-between border-t border-[var(--divider-soft)] pt-4">
              <Bar w={96} h={20} />
              <Bar w={60} h={8} />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

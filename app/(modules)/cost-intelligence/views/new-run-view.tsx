import { Bar, Button, Card, Label, Pill, Rows } from "../skeleton";
import { Checkpoint, Node, Timeline } from "./parts";

/** 1c: launching a run is a sentence; the run streams as a ledger. */
export function NewRunView() {
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <Bar w={36} h={20} />
          <div className="h-11 w-72 rounded-[var(--radius-control)] border border-[var(--border)] bg-white" />
          <Bar w={22} h={20} />
          <div className="h-11 w-80 rounded-[var(--radius-control)] border border-[var(--border)] bg-white" />
          <div className="flex-1" />
          <Button w={128} filled />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Pill w={140} />
          <Pill w={160} />
          <Pill w={150} />
          <Pill w={170} />
        </div>
        <Bar w={260} h={8} className="mt-4" />
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <Label>Run ledger</Label>
          <Rows
            n={5}
            gap="gap-4"
            row={() => (
              <div className="flex items-start gap-3">
                <Bar w={52} h={8} className="mt-1" />
                <Node />
                <div className="flex-1">
                  <Bar w="45%" h={10} />
                  <Bar w="70%" h={8} className="mt-1.5" />
                </div>
              </div>
            )}
          />
          <div className="mt-5">
            <Checkpoint columns />
          </div>
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <Label>Status</Label>
            <Timeline />
          </Card>
          <Card>
            <Label>Pinned for this run</Label>
            <Rows
              n={2}
              row={() => (
                <div>
                  <Bar w="80%" h={9} />
                  <Bar w="50%" h={7} className="mt-1.5" />
                </div>
              )}
            />
            <div className="mt-5 grid grid-cols-2 gap-4 border-t border-[var(--divider-soft)] pt-4">
              <div>
                <Bar w={50} h={7} />
                <Bar w={64} h={20} className="mt-2" />
              </div>
              <div>
                <Bar w={80} h={7} />
                <Bar w={64} h={20} className="mt-2" />
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

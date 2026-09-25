import { Bar } from "../ui/Bar";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Dropdown, type DropdownOption } from "../ui/Dropdown";
import { Label } from "../ui/Label";
import { Checkpoint, Node, Timeline } from "./parts";

// TODO(backend): replace with workflows and jobs from the Cost Intelligence API.
const PLACEHOLDER_WORKFLOWS: DropdownOption[] = [
  { value: "estimate-review", label: "Estimate review" },
  { value: "cost-rollup", label: "Cost rollup" },
  { value: "bid-comparison", label: "Bid comparison" },
];

const PLACEHOLDER_JOBS: DropdownOption[] = [
  { value: "job-a", label: "Sample job A" },
  { value: "job-b", label: "Sample job B" },
  { value: "job-c", label: "Sample job C" },
];

export function NewRunView() {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex flex-col gap-5">
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            Run
            <Dropdown label="Workflow" placeholder="Choose a workflow" options={PLACEHOLDER_WORKFLOWS} className="min-w-40 flex-1" />
            on
            <Dropdown label="Job" placeholder="Choose a job" options={PLACEHOLDER_JOBS} className="min-w-40 flex-1" />
            <Button variant="primary">Start run</Button>
          </div>
        </Card>

        <Card>
          <Label>Run ledger</Label>
          <div className="flex flex-col gap-4">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex items-start gap-3">
                <Bar w={52} h={8} className="mt-1" />
                <Node />
                <div className="flex-1">
                  <Bar w="45%" h={10} />
                  <Bar w="70%" h={8} className="mt-1.5" />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5">
            <Checkpoint columns />
          </div>
        </Card>
      </div>

      <div className="flex flex-col gap-5">
        <Card>
          <Label>Status</Label>
          <Timeline />
        </Card>
        <Card>
          <Label>Pinned for this run</Label>
          <div className="flex flex-col gap-3">
            {Array.from({ length: 2 }, (_, i) => (
              <div key={i}>
                <Bar w="80%" h={9} />
                <Bar w="50%" h={7} className="mt-1.5" />
              </div>
            ))}
          </div>
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
  );
}

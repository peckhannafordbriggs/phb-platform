import { RunDetail } from "./parts";
import { Card } from "../ui/Card";
import { Table } from "../ui/Table";

/** 1a: the runs list beside the selected run. */
export function RunsView() {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      <Card>
        <div className="mb-5 flex flex-wrap gap-2 border border-1 border-gray-300">
          Filters
        </div>
        <Table rows={8} cols={["85%", "80%", 110, 44]} />
      </Card>
      <RunDetail />
    </div>
  );
}

/** A single run, full width. */
export function RunView() {
  return (
    <div className="max-w-3xl">
      <RunDetail />
    </div>
  );
}


import type { WorkflowView } from "@/lib/modules/cost-intelligence/workflows";
import { Card } from "../ui/Card";
import { WorkflowEditor, WorkflowList, type CatalogOption } from "./workflow-editor";

/** Workflows on the left; the selected one on the right. Data comes from cip_workflows. */
export function WorkflowsView({
  workflows,
  selected,
  skills,
}: {
  workflows: WorkflowView[];
  selected: WorkflowView | null;
  skills: CatalogOption[];
}) {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[21rem_minmax(0,1fr)] lg:min-h-[22rem] lg:flex-[1_1_0px] lg:grid-rows-[minmax(0,1fr)]">
      <Card padding="p-0" className="flex min-h-0 flex-col">
        <WorkflowList
          workflows={workflows.map(({ id, name, status }) => ({ id, name, status }))}
          selected={selected?.id ?? null}
        />
      </Card>
      {selected ? (
        <WorkflowEditor key={selected.id} workflow={selected} skills={skills} />
      ) : (
        <Card className="flex min-h-0 items-center justify-center">
          <p className="text-[0.875rem] text-[var(--muted)]">No workflows yet. Press New workflow to start a draft.</p>
        </Card>
      )}
    </div>
  );
}

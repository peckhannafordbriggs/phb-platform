import { notFound } from "next/navigation";
import { requireModuleAdmin } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { listCatalogSkills } from "@/lib/modules/cost-intelligence/skill-sync";
import { listWorkflows } from "@/lib/modules/cost-intelligence/workflows";
import { CipShell } from "../../../cip-shell";
import { NewRunActions } from "../../../header-actions";
import { SettingsNav } from "../../../settings/settings-nav";
import { WorkflowsView } from "../../../views/workflows-view";

export const dynamic = "force-dynamic";

/** /settings/workflows shows the first workflow; /settings/workflows/<id> shows that one. */
export default async function WorkflowsPage({ params }: { params: Promise<{ workflowId?: string[] }> }) {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();

  const { workflowId } = await params;
  if (workflowId !== undefined && workflowId.length > 1) notFound();
  const [workflows, skills] = await Promise.all([listWorkflows(), listCatalogSkills()]);
  const selected = workflowId ? workflows.find((w) => w.id === workflowId[0]) : (workflows[0] ?? null);
  if (selected === undefined) notFound();

  return (
    <CipShell canAdminister actions={<NewRunActions canAdminister />}>
      <SettingsNav />
      <WorkflowsView
        workflows={workflows}
        selected={selected}
        skills={skills.map(({ folderName, name, version }) => ({ folderName, name, version }))}
      />
    </CipShell>
  );
}

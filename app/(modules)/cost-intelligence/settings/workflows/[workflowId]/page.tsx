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

export default async function WorkflowPage({ params }: { params: Promise<{ workflowId: string }> }) {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();

  const { workflowId } = await params;
  const [workflows, skills] = await Promise.all([listWorkflows(), listCatalogSkills()]);
  const selected = workflows.find((w) => w.id === workflowId);
  if (!selected) notFound();

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

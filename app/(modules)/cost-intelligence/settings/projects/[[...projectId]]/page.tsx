import { notFound } from "next/navigation";
import { requireModuleAdmin } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { getLatestProjectSync, listProjects, readProjectFiles } from "@/lib/modules/cost-intelligence/project-sync";
import { CipShell } from "../../../cip-shell";
import { NewRunActions } from "../../../header-actions";
import { SettingsNav } from "../../../settings/settings-nav";
import { ProjectsView } from "../../../views/projects-view";

export const dynamic = "force-dynamic";

/** /settings/projects shows the most recently changed project; /settings/projects/<id> shows that one. */
export default async function ProjectsPage({ params }: { params: Promise<{ projectId?: string[] }> }) {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();

  const { projectId } = await params;
  if (projectId !== undefined && projectId.length > 1) notFound();
  const [projects, lastSync] = await Promise.all([listProjects(), getLatestProjectSync()]);
  const selected = projectId ? projects.find((p) => p.id.toString() === projectId[0]) : (projects[0] ?? null);
  if (selected === undefined) notFound();
  const files = selected ? await readProjectFiles(selected.locationPath) : null;

  return (
    <CipShell canAdminister actions={<NewRunActions canAdminister />}>
      <SettingsNav />
      <ProjectsView projects={projects} selected={selected} files={files} lastSync={lastSync} />
    </CipShell>
  );
}

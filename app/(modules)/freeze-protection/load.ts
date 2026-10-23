import { getHistory, listEquipment } from "@/lib/modules/freeze-protection/equipment";
import { getProject, listProjects } from "@/lib/modules/freeze-protection/projects";

export type FpSearchParams = { project?: string; equipment?: string; new?: string };

/**
 * What Register and Report both show, resolved from the URL the same way: the
 * named project or else the first in the picker, its register, and the named
 * unit (the Register's selection, the Report's scope) with its history. An id
 * that does not resolve falls back rather than erroring, so an old bookmark
 * still opens something sensible.
 */
export async function loadProject(params: FpSearchParams) {
  const projects = await listProjects();
  const project =
    (params.project ? await getProject(params.project) : null) ??
    (projects[0] ? await getProject(projects[0].id) : null);
  const lines = project ? await listEquipment(project.id) : [];
  const unit = lines.find((l) => l.id === params.equipment) ?? null;
  const history = unit ? await getHistory(unit.id) : [];
  return {
    projects: projects.map(({ id, jobNumber, name }) => ({ id, jobNumber, name })),
    project,
    lines,
    unit,
    history,
  };
}

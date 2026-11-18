import { getHistory, listEquipment } from "@/lib/modules/freeze-protection/equipment";
import { getProject, listProjects } from "@/lib/modules/freeze-protection/projects";

export type FpSearchParams = { project?: string; equipment?: string; new?: string };

/**
 * What Register and Report both show, resolved from the URL the same way: the
 * named project, its equipment, and the named unit with its history. The
 * Register opens on the first unit when none is named; the Report's scope stays
 * the entire project unless one is.
 *
 * No project is chosen for a person: with none named, or one that no longer
 * resolves (an old bookmark), `project` is null and the page shows the project
 * catalog (Karthik, 2026-11-12). Before, it fell back to the first project.
 */
export async function loadProject(params: FpSearchParams, { firstUnitByDefault = false } = {}) {
  const projects = await listProjects();
  const project = params.project ? await getProject(params.project) : null;
  const lines = project ? await listEquipment(project.id) : [];
  const unit = lines.find((l) => l.id === params.equipment) ?? (firstUnitByDefault ? (lines[0] ?? null) : null);
  const history = unit ? await getHistory(unit.id) : [];
  return {
    projects: projects.map(({ id, jobNumber, name }) => ({ id, jobNumber, name })),
    project,
    lines,
    unit,
    history,
  };
}

import { getProject, listProjects } from "@/lib/modules/freeze-protection/projects";
import { getRegister, listVerifications } from "@/lib/modules/freeze-protection/verifications";

export type FpSearchParams = { project?: string; round?: string; building?: string; equipment?: string; new?: string };

/**
 * What Register and Report both show, resolved from the URL the same way:
 * the named project or else the first in the picker; the named round or else
 * the project's newest; the named building or else the whole project. An id
 * that does not resolve falls back rather than
 * erroring, so an old bookmark still opens something sensible.
 */
export async function loadRegister(params: FpSearchParams) {
  const projects = await listProjects();
  const project =
    (params.project ? await getProject(params.project) : null) ??
    (projects[0] ? await getProject(projects[0].id) : null);
  const verifications = project ? await listVerifications(project.id) : [];
  const verification = verifications.find((v) => v.id === params.round) ?? verifications[0] ?? null;
  const lines = verification ? await getRegister(verification.id) : [];
  // A building id that is not on this project falls back to the whole project.
  const building = project?.buildings.find((b) => b.id === params.building) ?? null;
  return {
    projects: projects.map(({ id, jobNumber, name }) => ({ id, jobNumber, name })),
    project,
    verifications,
    verification,
    lines,
    building,
  };
}

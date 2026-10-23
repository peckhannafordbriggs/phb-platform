import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { FpShell } from "../fp-shell";
import { ReportActions } from "../header-actions";
import { type FpSearchParams, loadProject } from "../load";
import { ReportView } from "../views/report-view";

export const dynamic = "force-dynamic";

/** A file name a person can read in a downloads folder: job, unit if scoped, date. */
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

export default async function ReportPage({ searchParams }: { searchParams: Promise<FpSearchParams> }) {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) notFound();

  const { projects, project, lines, unit, history } = await loadProject(await searchParams);
  const fileName = project
    ? `${slug(project.jobNumber)}${unit ? `-${slug(unit.name)}` : ""}-freeze-protection-${project.verificationDate}.html`
    : null;

  return (
    <FpShell
      projectId={project?.id}
      actions={
        <ReportActions
          projects={projects}
          projectId={project?.id ?? null}
          units={lines.map(({ id, name }) => ({ id, name }))}
          unitId={unit?.id ?? null}
          fileName={fileName}
        />
      }
    >
      <ReportView project={project} lines={lines} unit={unit} history={history} />
    </FpShell>
  );
}

import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { FpShell } from "../fp-shell";
import { ReportActions } from "../header-actions";
import { type FpSearchParams, loadRegister } from "../load";
import { ReportView } from "../views/report-view";

export const dynamic = "force-dynamic";

/** A file name a person can read in a downloads folder: job, building if scoped, date. */
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

export default async function ReportPage({ searchParams }: { searchParams: Promise<FpSearchParams> }) {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) notFound();

  const { projects, project, verification, lines, building } = await loadRegister(await searchParams);
  const fileName =
    project && verification
      ? `${slug(project.jobNumber)}${building ? `-${slug(building.name)}` : ""}-freeze-protection-${verification.verificationDate}.html`
      : null;

  return (
    <FpShell
      projectId={project?.id}
      roundId={verification?.id}
      buildingId={building?.id}
      actions={
        <ReportActions
          projects={projects}
          project={project}
          roundId={verification?.id ?? null}
          buildingId={building?.id ?? null}
          fileName={fileName}
        />
      }
    >
      <ReportView project={project} verification={verification} lines={lines} building={building} />
    </FpShell>
  );
}

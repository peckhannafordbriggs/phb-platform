import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { FpShell } from "../fp-shell";
import { ReportActions } from "../header-actions";
import { type FpSearchParams, loadRegister } from "../load";
import { ReportView } from "../views/report-view";

export const dynamic = "force-dynamic";

export default async function ReportPage({ searchParams }: { searchParams: Promise<FpSearchParams> }) {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) notFound();

  const { projects, project, verification, lines } = await loadRegister(await searchParams);

  return (
    <FpShell projectId={project?.id} roundId={verification?.id} actions={
        <ReportActions
          projects={projects}
          projectId={project?.id ?? null}
          fileName={project && verification ? `${project.jobNumber}-freeze-protection-${verification.verificationDate}.html` : null}
        />
      }>
      <ReportView project={project} verification={verification} lines={lines} />
    </FpShell>
  );
}

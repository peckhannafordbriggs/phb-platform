import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { MOCK_PROJECTS, mockEquipmentFor, mockProject } from "@/lib/modules/freeze-protection/mock";
import { FpShell } from "../fp-shell";
import { ReportActions } from "../header-actions";
import { ReportView } from "../views/report-view";

export const dynamic = "force-dynamic";

export default async function ReportPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) notFound();

  const params = await searchParams;
  // Design phase: mock registers. An unknown or missing project opens the first.
  const project = mockProject(params.project) ?? MOCK_PROJECTS[0]!;

  return (
    <FpShell
      projectId={project.id}
      actions={<ReportActions projects={MOCK_PROJECTS.map(({ id, name }) => ({ id, name }))} projectId={project.id} />}
    >
      <ReportView project={project} equipment={mockEquipmentFor(project.id)} />
    </FpShell>
  );
}

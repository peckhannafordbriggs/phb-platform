import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { MOCK_PROJECTS, mockEquipmentFor, mockProject } from "@/lib/modules/freeze-protection/mock";
import { FpShell } from "../fp-shell";
import { RegisterActions } from "../header-actions";
import { RegisterView } from "../views/register-view";

export const dynamic = "force-dynamic";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; equipment?: string }>;
}) {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) notFound();

  const params = await searchParams;
  // Design phase: mock registers. An unknown or missing project opens the first.
  const project = mockProject(params.project) ?? MOCK_PROJECTS[0]!;
  const equipment = mockEquipmentFor(project.id);
  const selected = equipment.find((e) => e.id === params.equipment) ?? null;

  return (
    <FpShell
      projectId={project.id}
      actions={<RegisterActions projects={MOCK_PROJECTS.map(({ id, name }) => ({ id, name }))} projectId={project.id} />}
    >
      <RegisterView project={project} equipment={equipment} selected={selected} />
    </FpShell>
  );
}

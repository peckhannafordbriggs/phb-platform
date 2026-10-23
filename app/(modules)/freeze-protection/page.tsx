import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { todayInNewYork } from "@/lib/modules/freeze-protection/dates";
import { FpShell } from "./fp-shell";
import { RegisterActions } from "./header-actions";
import { type FpSearchParams, loadProject } from "./load";
import { RegisterView } from "./views/register-view";

export const dynamic = "force-dynamic";

export default async function RegisterPage({ searchParams }: { searchParams: Promise<FpSearchParams> }) {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) notFound();

  const params = await searchParams;
  const { projects, project, lines, unit, history } = await loadProject(params, { firstUnitByDefault: true });
  const panel = params.new === "project" ? "project" : params.new === "equipment" && project ? "equipment" : null;

  return (
    <FpShell projectId={project?.id} actions={<RegisterActions projects={projects} projectId={project?.id ?? null} />}>
      <RegisterView project={project} lines={lines} selected={unit} history={history} panel={panel} today={todayInNewYork()} />
    </FpShell>
  );
}

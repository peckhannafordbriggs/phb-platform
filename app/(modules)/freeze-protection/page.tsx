import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { MOCK_EQUIPMENT, MOCK_PROJECTS } from "@/lib/modules/freeze-protection/mock";
import { FpShell } from "./fp-shell";
import { RegisterView } from "./views/register-view";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) notFound();

  // Design phase: mock registers. Replaced by the service layer.
  return (
    <FpShell>
      <RegisterView project={MOCK_PROJECTS[0]} equipment={MOCK_EQUIPMENT} selected={MOCK_EQUIPMENT[0]}/>
    </FpShell>
  );
}

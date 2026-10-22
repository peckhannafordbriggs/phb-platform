import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { FpShell } from "./fp-shell";
import { RegisterView } from "./views/register-view";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) notFound();

  // No service layer yet, so there is nothing to load: the register shows its empty state.
  return (
    <FpShell>
      <RegisterView project={null} verification={null} equipment={[]} selected={null} />
    </FpShell>
  );
}

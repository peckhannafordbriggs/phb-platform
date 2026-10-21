import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { MOCK_EQUIPMENT, MOCK_PROJECTS } from "@/lib/modules/freeze-protection/mock";
import { FpShell } from "./fp-shell";
import { OverviewView } from "./views/overview-view";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) notFound();

  // Design phase: mock registers. Replaced by the service layer.
  return (
    <FpShell>
      <OverviewView projects={MOCK_PROJECTS} equipment={MOCK_EQUIPMENT} />
    </FpShell>
  );
}

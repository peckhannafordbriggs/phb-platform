import { notFound } from "next/navigation";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { requireModuleAccess } from "@/lib/authz";
import {
  COST_INTELLIGENCE_MODULE_KEY,
  COST_INTELLIGENCE_MODULE_NAME,
} from "@/lib/modules/cost-intelligence/constants";

export const dynamic = "force-dynamic";

export default async function CostIntelligencePage() {
  const access = await requireModuleAccess(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <ModulePlaceholder
      moduleKey={COST_INTELLIGENCE_MODULE_KEY}
      title={COST_INTELLIGENCE_MODULE_NAME}
    />
  );
}

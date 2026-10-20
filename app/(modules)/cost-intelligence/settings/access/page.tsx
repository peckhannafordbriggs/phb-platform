import { notFound } from "next/navigation";
import { requireModuleAdmin } from "@/lib/authz";
import { listCipMembers } from "@/lib/modules/cost-intelligence/access";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { CipShell } from "../../cip-shell";
import { NewRunActions } from "../../header-actions";
import { SettingsNav } from "../../settings/settings-nav";
import { AccessView } from "../../views/access-view";

export const dynamic = "force-dynamic";

export default async function AccessPage() {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();

  const members = await listCipMembers();

  return (
    <CipShell canAdminister actions={<NewRunActions canAdminister />}>
      <SettingsNav />
      <AccessView members={members} />
    </CipShell>
  );
}

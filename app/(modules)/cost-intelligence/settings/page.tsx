import Link from "next/link";
import { notFound } from "next/navigation";
import { requireModuleAdmin } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { CipShell } from "../cip-shell";
import { Skeleton } from "../skeleton";
import { SettingsNav } from "./settings-nav";

export const dynamic = "force-dynamic";

export default async function SkillCatalogPage() {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <CipShell canAdminister>
      <SettingsNav />
      <Skeleton
        title="Skill catalog"
        items={[
          "Skills repository and branch, and when it was last checked against Git",
          "Skills table: name, status (published, draft, retired), live tag, package MD5",
        ]}
      >
        <Link href="/cost-intelligence/settings/skills/example" className="underline">Example skill</Link>
      </Skeleton>
    </CipShell>
  );
}

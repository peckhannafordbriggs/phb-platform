import { notFound } from "next/navigation";
import { ModuleHeader } from "@/components/module-header";
import { requireModuleAdmin } from "@/lib/authz";
import { getKbIndexStatus } from "@/lib/modules/knowledge-base/admin";
import {
  KNOWLEDGE_BASE_MODULE_KEY,
  KNOWLEDGE_BASE_MODULE_NAME,
} from "@/lib/modules/knowledge-base/constants";
import { moduleAccentStyle } from "@/lib/module-accent";
import { IndexPanel } from "./index-panel";

export const dynamic = "force-dynamic";

/** /knowledge-base/admin: the index, for Knowledge Base module admins. 404 for anyone else. */
export default async function KnowledgeBaseAdminPage() {
  const access = await requireModuleAdmin(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) notFound();

  const status = await getKbIndexStatus();

  return (
    <div className="mx-auto max-w-5xl" style={moduleAccentStyle(KNOWLEDGE_BASE_MODULE_KEY)}>
      <ModuleHeader
        moduleKey={KNOWLEDGE_BASE_MODULE_KEY}
        title={`${KNOWLEDGE_BASE_MODULE_NAME} · Index`}
        blurb="What is indexed from the library, and the button that reads it again."
      />
      <IndexPanel initial={status} />
    </div>
  );
}

import { notFound } from "next/navigation";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { requireModuleAccess } from "@/lib/authz";
import {
  KNOWLEDGE_BASE_MODULE_KEY,
  KNOWLEDGE_BASE_MODULE_NAME,
} from "@/lib/modules/knowledge-base/constants";

export const dynamic = "force-dynamic";

export default async function KnowledgeBasePage() {
  const access = await requireModuleAccess(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <ModulePlaceholder
      moduleKey={KNOWLEDGE_BASE_MODULE_KEY}
      title={KNOWLEDGE_BASE_MODULE_NAME}
    />
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import {
  KNOWLEDGE_BASE_MODULE_KEY,
  KNOWLEDGE_BASE_MODULE_NAME,
} from "@/lib/modules/knowledge-base/constants";

export const dynamic = "force-dynamic";

export default async function KnowledgeBasePage() {
  const access = await requireModuleAccess(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) notFound();

  // Search is not built yet; a module admin can already manage the index.
  const isAdmin = await hasModuleAdmin(access.viewer.id, KNOWLEDGE_BASE_MODULE_KEY);

  return (
    <ModulePlaceholder moduleKey={KNOWLEDGE_BASE_MODULE_KEY} title={KNOWLEDGE_BASE_MODULE_NAME}>
      {isAdmin && (
        <p className="mt-4 text-sm">
          <Link href="/knowledge-base/admin" className="font-medium underline underline-offset-2">
            Manage the index
          </Link>
        </p>
      )}
    </ModulePlaceholder>
  );
}

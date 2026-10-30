import Link from "next/link";
import { notFound } from "next/navigation";
import { ModuleHeader } from "@/components/module-header";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import {
  KNOWLEDGE_BASE_MODULE_KEY,
  KNOWLEDGE_BASE_MODULE_NAME,
} from "@/lib/modules/knowledge-base/constants";
import { listSearchableProjects } from "@/lib/modules/knowledge-base/search";
import { moduleAccentStyle } from "@/lib/module-accent";
import { SearchPanel } from "./search-panel";

export const dynamic = "force-dynamic";

/**
 * /knowledge-base: search past projects. Keyword search over the indexed
 * passages for now; answers written from them come next.
 */
export default async function KnowledgeBasePage() {
  const access = await requireModuleAccess(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) notFound();

  const [projects, isAdmin] = await Promise.all([
    listSearchableProjects(),
    hasModuleAdmin(access.viewer.id, KNOWLEDGE_BASE_MODULE_KEY),
  ]);

  return (
    <div className="mx-auto max-w-5xl" style={moduleAccentStyle(KNOWLEDGE_BASE_MODULE_KEY)}>
      <ModuleHeader
        moduleKey={KNOWLEDGE_BASE_MODULE_KEY}
        title={KNOWLEDGE_BASE_MODULE_NAME}
        blurb="Find where something was said in a past project's documents."
      >
        {isAdmin && (
          <Link href="/knowledge-base/admin" className="text-sm font-medium underline underline-offset-2">
            Manage the index
          </Link>
        )}
      </ModuleHeader>

      {projects.length === 0 ? (
        <div className="card mt-6 p-8 text-center text-sm text-[var(--muted)]">
          Nothing is indexed yet.{" "}
          {isAdmin ? (
            <Link href="/knowledge-base/admin" className="underline underline-offset-2">
              Index the library
            </Link>
          ) : (
            "A Knowledge Base admin has to index the library first."
          )}
        </div>
      ) : (
        <SearchPanel projects={projects} />
      )}
    </div>
  );
}

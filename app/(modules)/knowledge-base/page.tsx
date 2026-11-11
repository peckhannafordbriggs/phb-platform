import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ModuleHeader } from "@/components/module-header";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { getConversation } from "@/lib/modules/knowledge-base/ask";
import {
  KNOWLEDGE_BASE_MODULE_KEY,
  KNOWLEDGE_BASE_MODULE_NAME,
} from "@/lib/modules/knowledge-base/constants";
import { listSearchableProjects } from "@/lib/modules/knowledge-base/search";
import { moduleAccentStyle } from "@/lib/module-accent";
import { AskPanel } from "./ask-panel";
import { KbTabs } from "./kb-tabs";

export const dynamic = "force-dynamic";

/**
 * /knowledge-base[?c=<conversation id>]: ask about past projects. An answer
 * cites its sources; follow-ups continue the conversation. `c` opens one from
 * the shared history - anyone's, read only unless it is the viewer's own.
 */
export default async function KnowledgeBasePage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const access = await requireModuleAccess(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) notFound();

  const { c } = await searchParams;
  const conversationId = z.uuid().safeParse(c).success ? c! : null;
  const [projects, isAdmin, conversation] = await Promise.all([
    listSearchableProjects(),
    hasModuleAdmin(access.viewer.id, KNOWLEDGE_BASE_MODULE_KEY),
    conversationId ? getConversation(conversationId, access.viewer.id) : Promise.resolve(null),
  ]);

  return (
    <div className="mx-auto max-w-5xl" style={moduleAccentStyle(KNOWLEDGE_BASE_MODULE_KEY)}>
      <ModuleHeader
        moduleKey={KNOWLEDGE_BASE_MODULE_KEY}
        title={KNOWLEDGE_BASE_MODULE_NAME}
        blurb="Ask about past projects. Every answer cites the documents it came from."
      >
        {isAdmin && (
          <Link href="/knowledge-base/admin" className="text-sm font-medium underline underline-offset-2">
            Manage the index
          </Link>
        )}
      </ModuleHeader>
      <KbTabs current="/knowledge-base" />

      {conversationId && !conversation && (
        <p className="mt-4 text-sm text-[var(--muted)]">That conversation no longer exists.</p>
      )}
      {projects.length === 0 && !conversation ? (
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
        <AskPanel key={conversation?.id ?? "new"} projects={projects} initial={conversation} />
      )}
    </div>
  );
}

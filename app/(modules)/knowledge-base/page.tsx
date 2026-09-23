import { notFound } from "next/navigation";
import { ModuleHeader } from "@/components/module-header";
import { requireModuleAccess } from "@/lib/authz";
import { moduleAccentStyle } from "@/lib/module-accent";
import {
  KNOWLEDGE_BASE_MODULE_KEY,
  KNOWLEDGE_BASE_MODULE_NAME,
} from "@/lib/modules/knowledge-base/constants";
import { SearchPanel } from "./search-panel";

export const dynamic = "force-dynamic";

export default async function KnowledgeBasePage() {
  const access = await requireModuleAccess(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <div
      className="dashboard-ground -mx-8 -my-8 px-8 py-8"
      style={{
        ...moduleAccentStyle(KNOWLEDGE_BASE_MODULE_KEY),
        minHeight: "100vh",
      }}
    >
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-3xl flex-col">
        <ModuleHeader
          moduleKey={KNOWLEDGE_BASE_MODULE_KEY}
          title={KNOWLEDGE_BASE_MODULE_NAME}
        />

        <div className="flex flex-1 flex-col justify-center pb-16">
          <SearchPanel />
        </div>
      </div>
    </div>
  );
}

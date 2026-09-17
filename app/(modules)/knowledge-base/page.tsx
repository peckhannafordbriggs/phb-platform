import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { moduleAccentStyle } from "@/lib/module-accent";
import {
  KNOWLEDGE_BASE_MODULE_KEY,
} from "@/lib/modules/knowledge-base/constants";
import { SearchPanel } from "./search-panel";

export const dynamic = "force-dynamic";

export default async function KnowledgeBasePage() {
  const access = await requireModuleAccess(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <div
      className="dashboard-ground -mx-8 -my-8 px-8 py-8"
      style={{ ...moduleAccentStyle(KNOWLEDGE_BASE_MODULE_KEY), minHeight: "100vh" }}
    >
      {/* 4rem is the shell's own vertical padding, which the ground sits inside. */}
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-3xl flex-col">
        <div className="flex flex-1 flex-col justify-center pb-16 pt-10">
          <SearchPanel />
        </div>
      </div>
    </div>
  );
}

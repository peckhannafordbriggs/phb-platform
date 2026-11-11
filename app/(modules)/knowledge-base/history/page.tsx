import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ModuleHeader } from "@/components/module-header";
import { requireModuleAccess } from "@/lib/authz";
import { KB_HISTORY_PAGE, listConversations } from "@/lib/modules/knowledge-base/ask";
import {
  KNOWLEDGE_BASE_MODULE_KEY,
  KNOWLEDGE_BASE_MODULE_NAME,
} from "@/lib/modules/knowledge-base/constants";
import { moduleAccentStyle } from "@/lib/module-accent";
import { KbTabs } from "../kb-tabs";

export const dynamic = "force-dynamic";

const params = z.object({
  mine: z.enum(["1"]).optional(),
  before: z.iso.datetime().optional(),
  beforeId: z.uuid().optional(),
});

/**
 * /knowledge-base/history: everyone's questions, newest activity first, with
 * who asked. Shared by decision (docs/KB-P0-P1.md): one person's answer is
 * another's search result. `mine=1` for the viewer's own.
 */
export default async function KnowledgeBaseHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await requireModuleAccess(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) notFound();

  const parsed = params.safeParse(await searchParams);
  const query = parsed.success ? parsed.data : {};
  const mine = query.mine === "1";
  const conversations = await listConversations({
    ...(mine ? { employeeId: access.viewer.id } : {}),
    ...(query.before && query.beforeId ? { before: { updatedAt: new Date(query.before), id: query.beforeId } } : {}),
  });
  const last = conversations.at(-1);
  const older =
    conversations.length === KB_HISTORY_PAGE && last
      ? `/knowledge-base/history?${new URLSearchParams({
          ...(mine ? { mine: "1" } : {}),
          before: last.updatedAt,
          beforeId: last.id,
        })}`
      : null;

  return (
    <div className="mx-auto max-w-5xl" style={moduleAccentStyle(KNOWLEDGE_BASE_MODULE_KEY)}>
      <ModuleHeader moduleKey={KNOWLEDGE_BASE_MODULE_KEY} title={KNOWLEDGE_BASE_MODULE_NAME} blurb="Every question asked, by everyone." />
      <KbTabs current="/knowledge-base/history" />

      <div className="mt-4 flex gap-4 text-sm">
        <Link href="/knowledge-base/history" className={mine ? "text-[var(--muted)] underline underline-offset-2" : "font-medium"}>
          Everyone
        </Link>
        <Link href="/knowledge-base/history?mine=1" className={mine ? "font-medium" : "text-[var(--muted)] underline underline-offset-2"}>
          Mine
        </Link>
      </div>

      {conversations.length === 0 ? (
        <div className="card mt-4 p-8 text-center text-sm text-[var(--muted)]">
          {mine ? "You have not asked anything yet." : "Nobody has asked anything yet."}
        </div>
      ) : (
        <ul className="card mt-4 divide-y divide-[var(--divider-soft)]">
          {conversations.map((c) => (
            <li key={c.id}>
              <Link href={`/knowledge-base?c=${c.id}`} className="block px-5 py-3 hover:bg-[var(--surface)]">
                <span className="font-medium">{c.firstQuestion}</span>
                <span className="mt-0.5 block text-xs text-[var(--muted)]">
                  {c.startedBy?.name ?? "A former employee"} ·{" "}
                  {new Date(c.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" })}
                  {c.questionCount > 1 && ` · ${c.questionCount} questions`}
                  {c.lastAnswerKind === "no_evidence" && " · not answered by the documents"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {older && (
        <Link href={older} className="mt-4 inline-block text-sm underline underline-offset-2">
          Older
        </Link>
      )}
    </div>
  );
}

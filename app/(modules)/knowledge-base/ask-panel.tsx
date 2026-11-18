"use client";

import { useState } from "react";
import type { KbAskedQuestion, KbAskResult } from "@/lib/modules/knowledge-base/ask";
import type { KbSearchResult } from "@/lib/modules/knowledge-base/search";
import { AnswerCard } from "./answer-card";
import { SearchResults, type Project } from "./search-panel";

/**
 * Ask a question about past projects; get a short answer citing its sources,
 * then follow up in the same conversation. Every answer is saved to the
 * shared history. The search behind the latest answer is beneath it.
 *
 * Without Claude configured (503) or when it does not answer (502), the
 * search still runs and its results are shown with the reason.
 */

type Conversation = {
  id: string;
  startedBy: { id: string; name: string } | null;
  mine: boolean;
  questions: KbAskedQuestion[];
};

export function AskPanel({ projects, initial }: { projects: Project[]; initial: Conversation | null }) {
  const [conversationId, setConversationId] = useState<string | null>(initial?.id ?? null);
  const [thread, setThread] = useState<KbAskedQuestion[]>(initial?.questions ?? []);
  const [mine, setMine] = useState(initial?.mine ?? true);
  const [startedBy, setStartedBy] = useState(initial?.startedBy ?? null);
  const [search, setSearch] = useState<KbSearchResult | null>(null);
  const [question, setQuestion] = useState("");
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startOver() {
    setConversationId(null);
    setThread([]);
    setMine(true);
    setStartedBy(null);
    setSearch(null);
    setError(null);
    setQuestion("");
    window.history.replaceState(null, "", "/knowledge-base");
  }

  async function searchOnly(q: string) {
    const params = new URLSearchParams({ q });
    if (project) params.append("project", project);
    const response = await fetch(`/api/modules/knowledge-base/search?${params}`, { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as { data?: KbSearchResult } | null;
    if (body?.data) setSearch(body.data);
  }

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/modules/knowledge-base/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          ...(conversationId ? { conversationId } : {}),
          ...(project && !conversationId ? { projectIds: [project] } : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { data?: KbAskResult; error?: { code?: string; message?: string } }
        | null;
      if (response.ok && body?.data) {
        const { asked, search: behind } = body.data;
        setThread((t) => [...t, asked]);
        setConversationId(asked.conversationId);
        setSearch(behind);
        setQuestion("");
        window.history.replaceState(null, "", `/knowledge-base?c=${asked.conversationId}`);
        return;
      }
      setError(body?.error?.message ?? "That did not work. Try again.");
      // The search still helps when Claude cannot answer.
      if (body?.error?.code === "not_configured" || body?.error?.code === "answer_failed") await searchOnly(q);
    } finally {
      setBusy(false);
    }
  }

  const followUp = thread.length > 0;
  return (
    <div className="mt-6 space-y-6">
      {thread.map((asked) => (
        <AnswerCard key={asked.id} asked={asked} />
      ))}

      {followUp && !mine ? (
        <div className="card flex flex-wrap items-center justify-between gap-3 p-5 text-sm">
          <span className="text-[var(--muted)]">
            Asked by {startedBy?.name ?? "a former employee"}. Only they can add follow-ups here.
          </span>
          <button type="button" onClick={startOver} className="font-medium underline underline-offset-2">
            Ask your own question
          </button>
        </div>
      ) : (
        <form onSubmit={(e) => void ask(e)} className="card flex flex-wrap items-end gap-3 p-5">
          <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">{followUp ? "Ask a follow-up" : "Ask about past projects"}</span>
            <input
              type="search"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={followUp ? "e.g. and RTU-2?" : 'e.g. What is the operating weight of RTU-3 on 221457?'}
              maxLength={500}
              className="h-9 rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3"
              autoFocus
            />
          </label>
          {!followUp && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Project</span>
              <select
                value={project}
                onChange={(e) => setProject(e.target.value)}
                className="h-9 rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-2"
              >
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.folderName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="submit"
            disabled={busy || !question.trim()}
            className="inline-flex h-9 items-center rounded-[var(--radius-control)] bg-[var(--module-accent)] px-4 text-[0.8125rem] font-medium text-white hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
          >
            {busy ? "Working…" : "Ask"}
          </button>
          {followUp && (
            <button type="button" onClick={startOver} className="h-9 text-sm underline underline-offset-2">
              New question
            </button>
          )}
        </form>
      )}

      {busy && <p className="text-sm text-[var(--muted)]">Searching, sorting and writing the answer. This takes a few seconds.</p>}
      {error && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      )}

      {search && (
        <details open={thread.length === 0}>
          <summary className="cursor-pointer text-sm font-medium">Everything the search found</summary>
          <div className="mt-3">
            <SearchResults result={search} projects={projects} />
          </div>
        </details>
      )}
    </div>
  );
}

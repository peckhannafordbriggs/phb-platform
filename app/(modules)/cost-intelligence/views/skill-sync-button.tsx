"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "../ui/Button";

type Outcome = {
  status: "ok" | "partial" | "failed";
  skillsAdded: number;
  skillsUpdated: number;
  skillsDeleted: number;
  message: string | null;
};

/** Runs a skill sync, then refreshes the page so the list and "Last synced" line update. */
export function SkillSyncButton() {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function sync() {
    setSyncing(true);
    setNote(null);
    try {
      const response = await fetch("/api/modules/cost-intelligence/skills/sync", { method: "POST" });
      const body = (await response.json().catch(() => null)) as
        | { data?: Outcome; error?: { message: string } }
        | null;

      if (!response.ok || !body?.data) {
        setNote(body?.error?.message ?? "Sync failed. Try again.");
      } else if (body.data.status === "failed") {
        setNote(body.data.message ?? "Sync failed.");
      } else {
        const { skillsAdded, skillsUpdated, skillsDeleted } = body.data;
        setNote(`${skillsAdded} added, ${skillsUpdated} updated, ${skillsDeleted} removed`);
      }
      router.refresh();
    } catch {
      setNote("Could not reach the server. Try again.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {note && <span className="max-w-[12rem] truncate text-[0.75rem] text-[var(--muted)]" title={note}>{note}</span>}
      <Button onClick={sync} disabled={syncing}>
        <RefreshCw size={14} aria-hidden="true" className={syncing ? "animate-spin" : undefined} />
        {syncing ? "Syncing…" : "Sync"}
      </Button>
    </div>
  );
}

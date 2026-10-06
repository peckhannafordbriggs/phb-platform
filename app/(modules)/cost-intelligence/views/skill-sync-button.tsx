"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "../ui/Button";

/**
 * Runs a skill sync, then refreshes the page so the list and the status line
 * update. Only a request that never produced a sync row (409, network) shows a
 * message here, floated under the button so the header never reflows; every
 * other outcome is in the status line.
 */
export function SkillSyncButton() {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sync() {
    setSyncing(true);
    setError(null);
    try {
      const response = await fetch("/api/modules/cost-intelligence/skills/sync", { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message: string } } | null;
        setError(body?.error?.message ?? "Sync failed. Try again.");
      }
      router.refresh();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="relative shrink-0">
      <Button onClick={sync} disabled={syncing}>
        <RefreshCw size={14} aria-hidden="true" className={syncing ? "animate-spin" : undefined} />
        {syncing ? "Syncing…" : "Sync"}
      </Button>
      {error && (
        <p role="alert" className="absolute right-0 top-full z-10 mt-1 w-56 rounded-md bg-white p-2 text-[0.75rem] shadow-md">
          {error}
        </p>
      )}
    </div>
  );
}

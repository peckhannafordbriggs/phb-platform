import "./load-env";
import { createMailService } from "../lib/modules/change-orders/mail/service";
import { graphTokenProvider } from "../lib/modules/change-orders/graph/credential";

/**
 * Where the Change Orders screen actually spends its time.
 *
 * Instruments the transport rather than guessing: every Graph request the
 * service makes is timed and attributed to the operation that caused it, so a
 * slow screen can be blamed on round-trip COUNT, round-trip LATENCY, or neither
 * - which is what tells you whether to look at the service or at dev-mode
 * compilation.
 *
 * Read-only. It lists, reads and searches; it writes nothing and never sends.
 *
 *   npx tsx scripts/co-measure.ts
 *
 * PHASE-9 measured listFolders() at 11 requests and ~1.3s cold. That was before
 * conversation grouping, which the UI now defaults ON - so the default list path
 * is listConversations(), not listMessages(), and it is measured here alongside
 * the flat one. A number for a path the UI no longer takes is worse than no
 * number, because it gets quoted.
 */

interface Call {
  method: string;
  url: string;
  ms: number;
  bytes: number;
}

let calls: Call[] = [];

function shortUrl(url: string): string {
  return url
    .replace("https://graph.microsoft.com/v1.0/users/", "")
    .replace(/^[^/]+/, "…")
    .replace(/\?.*$/, (q) => (q.length > 60 ? `${q.slice(0, 60)}…` : q));
}

/** Which service operation a URL belongs to, for the phase breakdown. */
function phaseOf(url: string): string {
  if (/\/mailFolders\/[a-z]+(\?|$)/i.test(url.replace(/.*\/mailFolders/, "/mailFolders")))
    return "well-known alias lookup";
  if (/\/mailFolders\?/.test(url)) return "folder page (root)";
  if (/\/childFolders/.test(url)) return "folder page (children)";
  if (/\/messages\?.*\$skip=/.test(url)) return "message page (offset)";
  if (/\/messages\?/.test(url)) return "message page (first)";
  if (/\/messages\/[^/]+\/attachments/.test(url)) return "attachments";
  if (/\/messages\/[^/]+/.test(url)) return "one message";
  return "other";
}

const service = createMailService({
  tokenProvider: graphTokenProvider(),
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const started = performance.now();
    const response = await globalThis.fetch(input as RequestInfo, init as RequestInit);
    const ms = performance.now() - started;
    // Read the body through a clone so timing and size can both be had without
    // consuming the response the service is about to parse.
    let bytes = 0;
    try {
      bytes = (await response.clone().arrayBuffer()).byteLength;
    } catch {
      bytes = 0;
    }
    calls.push({ method: init?.method ?? "GET", url, ms, bytes });
    return response;
  },
});

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

interface Measurement {
  label: string;
  count: number;
  wall: number;
  summed: number;
  bytes: number;
}

const table: Measurement[] = [];

/** Runs one labelled step and reports the Graph traffic it caused. */
async function step<T>(
  label: string,
  run: () => Promise<T>,
  { phases = false }: { phases?: boolean } = {},
): Promise<T> {
  calls = [];
  const started = performance.now();
  const result = await run();
  const wall = performance.now() - started;

  const total = calls.reduce((sum, c) => sum + c.ms, 0);
  const bytes = calls.reduce((sum, c) => sum + c.bytes, 0);
  const slowest = [...calls].sort((a, b) => b.ms - a.ms)[0];

  table.push({ label, count: calls.length, wall, summed: total, bytes });

  say("");
  say(`${label}`);
  say(
    `  ${calls.length} Graph request(s), ${wall.toFixed(0)}ms wall, ` +
      `${total.toFixed(0)}ms summed, ${kb(bytes)} returned`,
  );
  if (slowest !== undefined) {
    say(`  slowest: ${slowest.ms.toFixed(0)}ms  ${shortUrl(slowest.url)}`);
  }
  // Parallelism: summed >> wall means requests overlapped.
  if (calls.length > 1) {
    say(
      `  mean ${(total / calls.length).toFixed(0)}ms, ` +
        `${total > wall * 1.3 ? "overlapped" : "SEQUENTIAL"}`,
    );
  }

  /**
   * The phase breakdown exists for listFolders specifically. 11 requests is a
   * number; "one folder listing, four alias lookups that could overlap it, and
   * six child pages that cannot" is a diagnosis.
   */
  if (phases && calls.length > 1) {
    const byPhase = new Map<string, { n: number; ms: number }>();
    for (const c of calls) {
      const key = phaseOf(c.url);
      const cur = byPhase.get(key) ?? { n: 0, ms: 0 };
      byPhase.set(key, { n: cur.n + 1, ms: cur.ms + c.ms });
    }
    say("  phases:");
    for (const [key, v] of [...byPhase.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
      say(`    ${String(v.n).padStart(2)} x ${key.padEnd(26)} ${v.ms.toFixed(0)}ms`);
    }
  }
  return result;
}

void (async () => {
  say("Measuring the Change Orders screen against the live mailbox.");
  say("Read-only: nothing is written and nothing is sent.");

  // ---- What one page load costs, in the order the UI does it.

  const folders = await step(
    "listFolders()  — the folder pane, on every mount",
    () => service.listFolders(),
    { phases: true },
  );
  say(`  (${folders.length} folders in the tree)`);

  const drafts = folders.find((f) => f.wellKnownName === "drafts");
  const inbox = folders.find((f) => f.wellKnownName === "inbox");

  // The UI defaults the selection to Drafts, so that is the folder whose open
  // cost matters most. Inbox is measured too because it is the busy one, and
  // the two costs are not close.
  const target = drafts ?? inbox ?? folders[0];
  if (target === undefined) {
    say("No folders; nothing further to measure.");
    return;
  }

  say("");
  say("=== The default list path: grouped ===");
  say("  The UI mounts with grouping ON, so this is what a folder open costs.");

  const groupedDrafts = await step(
    `listConversations("${target.displayName}") — DEFAULT path, what the UI calls`,
    () => service.listConversations(target.id),
  );
  say(
    `  (${groupedDrafts.conversations.length} conversations from ` +
      `${groupedDrafts.messageCount} messages` +
      `${groupedDrafts.truncated ? ", CAPPED" : ""})`,
  );

  if (inbox !== undefined && inbox.id !== target.id) {
    const groupedInbox = await step(
      `listConversations("${inbox.displayName}") — the busy folder, grouped`,
      () => service.listConversations(inbox.id),
    );
    say(
      `  (${groupedInbox.conversations.length} conversations from ` +
        `${groupedInbox.messageCount} messages` +
        `${groupedInbox.truncated ? ", CAPPED" : ""})`,
    );
  }

  say("");
  say("=== The same folder, flat, for comparison ===");

  const page = await step(
    `listMessages("${target.displayName}", top=25) — flat, one page`,
    () => service.listMessages(target.id, { top: 25 }),
  );

  if (inbox !== undefined && inbox.id !== target.id) {
    await step(
      `listMessages("${inbox.displayName}", top=25) — flat, one page`,
      () => service.listMessages(inbox.id, { top: 25 }),
    );
  }

  say("");
  say("=== Opening a message ===");

  const first = page.messages[0];
  if (first !== undefined) {
    await step("getMessage() — opening one message", () =>
      service.getMessage(first.id),
    );

    if (first.hasAttachments) {
      await step("listAttachments() — the second call the reading pane makes", () =>
        service.listAttachments(first.id),
      );
    }
  }

  say("");
  say("=== Searching ===");

  await step('searchMessages("CO") — one subject search', () =>
    service.searchMessages(target.id, "CO"),
  );

  // ---- The two things that repeat on a timer while the tab is open.

  say("");
  say("=== What repeats while the tab sits open ===");
  say("  message list poll : every 20s, visible tabs only  -> listConversations");
  say("  draft lock refresh: every 45s, editor open only   -> getDraftForEdit");

  await step(
    "one poll tick — listConversations() again, 20s apart in real use",
    () => service.listConversations(target.id),
  );

  const draftPage =
    drafts === undefined
      ? { messages: [] }
      : await service.listMessages(drafts.id, { top: 5 });
  const draft = draftPage.messages.find((m) => m.isDraft);

  if (draft !== undefined) {
    await step("getDraftForEdit() — one lock refresh tick", () =>
      service.getDraftForEdit(draft.id),
    );
  } else {
    say("");
    say("  (no draft in Drafts, so the lock-refresh cost was not measured)");
  }

  // ---- Caching: what a second visit costs.

  say("");
  say("=== Second visit, same process ===");

  await step("listFolders() again — warm folder cache", () =>
    service.listFolders(),
  );

  await step(
    "listConversations() again — is there a message cache? (expect: no)",
    () => service.listConversations(target.id),
  );

  // ---- Summary, so the shape is visible without reading the whole log.

  say("");
  say("=".repeat(78));
  say("SUMMARY — one cold mount is the first two rows added together");
  say("=".repeat(78));
  say(
    `${"operation".padEnd(52)} ${"reqs".padStart(5)} ${"wall".padStart(8)} ${"returned".padStart(9)}`,
  );
  for (const m of table) {
    const short = m.label.replace(/ —.*$/, "").slice(0, 52);
    say(
      `${short.padEnd(52)} ${String(m.count).padStart(5)} ` +
        `${`${m.wall.toFixed(0)}ms`.padStart(8)} ${kb(m.bytes).padStart(9)}`,
    );
  }

  const mount = table.slice(0, 2);
  const mountReqs = mount.reduce((s, m) => s + m.count, 0);
  const mountWall = mount.reduce((s, m) => s + m.wall, 0);
  say("");
  say(
    `Cold mount (folders + default grouped list): ${mountReqs} requests, ` +
      `${mountWall.toFixed(0)}ms of Graph time.`,
  );
  say(
    "That is Graph round trips only. It excludes the per-request grant check " +
      "on\nevery API route, Next.js render, and dev-mode compilation.",
  );
})();

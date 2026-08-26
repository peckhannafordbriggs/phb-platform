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
 */

interface Call {
  method: string;
  url: string;
  ms: number;
}

let calls: Call[] = [];

function shortUrl(url: string): string {
  return url
    .replace("https://graph.microsoft.com/v1.0/users/", "")
    .replace(/^[^/]+/, "…")
    .replace(/\?.*$/, (q) => (q.length > 60 ? `${q.slice(0, 60)}…` : q));
}

const service = createMailService({
  tokenProvider: graphTokenProvider(),
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const started = performance.now();
    const response = await globalThis.fetch(input as RequestInfo, init as RequestInit);
    calls.push({
      method: init?.method ?? "GET",
      url,
      ms: performance.now() - started,
    });
    return response;
  },
});

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Runs one labelled step and reports the Graph traffic it caused. */
async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  calls = [];
  const started = performance.now();
  const result = await run();
  const wall = performance.now() - started;

  const total = calls.reduce((sum, c) => sum + c.ms, 0);
  const slowest = [...calls].sort((a, b) => b.ms - a.ms)[0];

  say("");
  say(`${label}`);
  say(
    `  ${calls.length} Graph request(s), ${wall.toFixed(0)}ms wall, ` +
      `${total.toFixed(0)}ms summed`,
  );
  if (slowest !== undefined) {
    say(`  slowest: ${slowest.ms.toFixed(0)}ms  ${shortUrl(slowest.url)}`);
  }
  // Parallelism: summed >> wall means requests overlapped.
  if (calls.length > 1) {
    say(
      `  mean ${(total / calls.length).toFixed(0)}ms, ` +
        `${total > wall * 1.3 ? "overlapped" : "sequential"}`,
    );
  }
  return result;
}

void (async () => {
  say("Measuring the Change Orders screen against the live mailbox.");
  say("Read-only: nothing is written and nothing is sent.");

  // ---- What one page load costs, in the order the UI does it.

  const folders = await step("listFolders()  — the folder pane, on every mount", () =>
    service.listFolders(),
  );

  const drafts = folders.find((f) => f.wellKnownName === "drafts");
  const inbox = folders.find((f) => f.wellKnownName === "inbox");
  const target = inbox ?? drafts ?? folders[0];
  if (target === undefined) {
    say("No folders; nothing further to measure.");
    return;
  }

  const page = await step(
    `listMessages("${target.displayName}") — the message list`,
    () => service.listMessages(target.id, { top: 25 }),
  );

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

  await step('searchMessages("CO") — one subject search', () =>
    service.searchMessages(target.id, "CO"),
  );

  // ---- The two things that repeat on a timer while the tab is open.

  say("");
  say("=== What repeats while the tab sits open ===");
  say("  message list poll : every 60s, visible tabs only  -> listMessages");
  say("  draft lock refresh: every 45s, editor open only   -> getDraftForEdit");

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

  // ---- Token caching: the second call must not re-authenticate.

  await step("listFolders() again — warm token, same process", () =>
    service.listFolders(),
  );
})();

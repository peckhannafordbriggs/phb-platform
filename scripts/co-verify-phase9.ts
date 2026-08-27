// FIRST, and it has to be: lib/env.ts parses process.env at import time, so the
// environment must be loaded before any import below is evaluated. See load-env.ts.
import "./load-env";

import { mailService } from "../lib/modules/change-orders/mail/service";
import { isZzTestSubject } from "../lib/modules/change-orders/mail/guards";
import { isMailError } from "../lib/modules/change-orders/mail/errors";
import type {
  ConversationGroup,
  MailFolderSummary,
  MessageSummary,
} from "../lib/modules/change-orders/mail/types";

/**
 * Phase 9 verification, against the live changeorder@phb1899.com mailbox.
 *
 * Why this exists rather than a test: every Graph phase so far found defects a
 * mocked transport agreed with - `wellKnownName` not existing in v1.0, Projects
 * sitting at depth 2, mail paging with `$skip` and not `$skiptoken`, `$search`
 * ignoring the ImmutableId header, `$filter` with `$orderby` returning 400.
 * Phase 9 makes two claims about Exchange that a stub cannot check: that
 * `conversationId` really does thread this mailbox the way the automation
 * assumes, and how long a change made in Outlook takes to become visible through
 * Graph. The second is the number that decides whether Part B is worth building.
 *
 * What this script CANNOT do, structurally:
 *
 *  - Send anything. `sendDraft` appears nowhere in it, `PHB_ALLOW_SEND` is never
 *    read or set, and every command below is either a read or a ZZTEST-fenced
 *    write that Exchange can undo.
 *  - Touch a message that is not a ZZTEST. Writes go through the service, which
 *    reads the subject from Exchange and applies the fence; this script checks
 *    the same thing first so a mistake is a clear refusal here rather than a
 *    MailError from three frames down.
 *
 * Usage:
 *
 *   npx tsx scripts/co-verify-phase9.ts survey
 *       Read-only. Groups every folder that has messages and reports the
 *       threads, the cost, and - the point of it - whether grouping and the flat
 *       listing contain exactly the same messages. Start here.
 *
 *   npx tsx scripts/co-verify-phase9.ts groups <folderId>
 *       One folder in detail: every conversation, its participants, and each
 *       message under it in the order the pane will show them.
 *
 *   npx tsx scripts/co-verify-phase9.ts watch <folderId> <needle> appear|vanish
 *       The instrument for the six sync directions. Do the thing in Outlook,
 *       and this reports how long Graph took to agree. Polls every 2s so the
 *       number measured is Exchange's propagation, not our 20s UI interval.
 *
 *   npx tsx scripts/co-verify-phase9.ts propagate <draftId>
 *       Edits a ZZTEST draft and times how long the change takes to appear in
 *       the folder LISTING - the read the pane actually makes. The
 *       platform-initiated half of the sync matrix. Restores the subject after.
 *
 *   npx tsx scripts/co-verify-phase9.ts conflict <draftId>
 *       Proves the concurrent-edit detection on a ZZTEST draft: takes a
 *       changeKey, changes the draft underneath it, then saves with the stale
 *       key and checks the service refuses with `conflict` rather than
 *       overwriting. Creates no message and sends nothing.
 */

const service = mailService();

function say(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function fail(line: string): never {
  process.stderr.write(`${line}\n`);
  process.exit(1);
}

/** Milliseconds, measured around one call. */
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
}

function shortDate(value: string | null): string {
  if (value === null) return "no date";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "bad date" : parsed.toISOString().slice(0, 16);
}

function describeGroup(group: ConversationGroup): string {
  // Middle dot, not a comma: plenty of these display names are "Last, First".
  const who = group.participants
    .map((p) => p.name ?? p.address)
    .slice(0, 3)
    .join(" · ");

  const badges = [
    `${group.messageCount} msg`,
    group.unreadCount > 0 ? `${group.unreadCount} unread` : null,
    group.draftCount > 0 ? `${group.draftCount} DRAFT` : null,
    group.hasAttachments ? "attach" : null,
  ]
    .filter((b) => b !== null)
    .join(" | ");

  return `${shortDate(group.newestDateTime)}  [${badges}]  ${group.subject ?? "(no subject)"}\n      ${who}`;
}

/**
 * Every folder that has something in it.
 *
 * The tree is walked once and reused: listFolders costs 11 Graph requests
 * against this mailbox, which is most of a second, and the survey has no reason
 * to pay it more than once.
 */
async function foldersWithMessages(): Promise<MailFolderSummary[]> {
  const folders = await service.listFolders();
  return folders.filter((f) => f.totalItemCount > 0);
}

/**
 * The check that matters most in the survey.
 *
 * Grouping is a display concern, so the set of messages in a grouped listing
 * must equal the set in the flat listing. A group that quietly dropped or
 * duplicated a message is the failure this codebase cares about most, and it
 * would be invisible on screen - the pane would simply look tidy.
 *
 * The flat side is read page by page to the same cap, so this compares the two
 * paths rather than comparing the grouped path with itself.
 */
async function compareGroupedWithFlat(folderId: string): Promise<{
  ok: boolean;
  grouped: number;
  flat: number;
  missing: string[];
  extra: string[];
}> {
  const grouped = await service.listConversations(folderId);
  const groupedIds = new Set(
    grouped.conversations.flatMap((c) => c.messages.map((m) => m.id)),
  );

  const flatIds = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const result = await service.listMessages(folderId, { top: 100, cursor });
    for (const message of result.messages) flatIds.add(message.id);
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }

  const missing = [...flatIds].filter((id) => !groupedIds.has(id));
  const extra = [...groupedIds].filter((id) => !flatIds.has(id));

  return {
    ok: missing.length === 0 && extra.length === 0,
    grouped: groupedIds.size,
    flat: flatIds.size,
    missing,
    extra,
  };
}

async function survey(): Promise<void> {
  say("Phase 9 survey - conversation grouping against the live mailbox");
  say("Read-only. Nothing below writes, moves, deletes or sends.");
  say();

  const folders = await foldersWithMessages();
  say(`${folders.length} folders hold messages.`);
  say();

  let threadedFolders = 0;
  let longestThread = 0;
  let mismatches = 0;

  for (const folder of folders) {
    const { value: page, ms } = await timed(() => service.listConversations(folder.id));

    const multi = page.conversations.filter((c) => c.messageCount > 1);
    if (multi.length > 0) threadedFolders += 1;
    for (const group of page.conversations) {
      longestThread = Math.max(longestThread, group.messageCount);
    }

    say(
      `## ${folder.displayName}  (${folder.totalItemCount} items) - ` +
        `${page.conversations.length} conversations from ${page.messageCount} messages, ${ms}ms` +
        (page.truncated ? `  TRUNCATED (${page.truncation})` : ""),
    );

    for (const group of page.conversations.slice(0, 8)) {
      say(`   ${describeGroup(group)}`);
    }
    if (page.conversations.length > 8) {
      say(`   ... and ${page.conversations.length - 8} more`);
    }
    // Printed so the other commands can be pointed at a folder without a
    // second lookup - `watch` and `groups` both take one.
    say(`   folderId: ${folder.id}`);

    const comparison = await compareGroupedWithFlat(folder.id);
    if (comparison.ok) {
      say(`   OK grouped and flat agree on all ${comparison.flat} messages`);
    } else {
      mismatches += 1;
      say(
        `   MISMATCH grouped=${comparison.grouped} flat=${comparison.flat} ` +
          `missing=${comparison.missing.length} extra=${comparison.extra.length}`,
      );
    }
    say();
  }

  say("---");
  say(`Folders containing a real thread (>1 message): ${threadedFolders}`);
  say(`Longest conversation found: ${longestThread} messages`);
  say(
    mismatches === 0
      ? "Grouped and flat listings agree everywhere. Grouping loses nothing."
      : `MISMATCHES IN ${mismatches} FOLDERS - grouping is dropping or inventing messages.`,
  );
}

async function groups(folderId: string): Promise<void> {
  const folder = await service.getFolder(folderId);
  const page = await service.listConversations(folderId);

  say(`${folder.displayName}: ${page.conversations.length} conversations, ${page.messageCount} messages`);
  if (page.truncated) say(`TRUNCATED at the ${page.truncation} cap.`);
  say();

  for (const group of page.conversations) {
    say(describeGroup(group));
    say(`      conversationId: ${group.id}`);
    // Oldest first, which is the order the expanded pane shows them in.
    for (const message of group.messages) {
      const flags = [
        message.isDraft ? "DRAFT" : null,
        message.isRead ? null : "unread",
        message.hasAttachments ? "attach" : null,
      ]
        .filter((f) => f !== null)
        .join(",");

      say(
        `        - ${shortDate(message.receivedDateTime)}  ${flags.padEnd(14)}` +
          `${message.from?.address ?? "(no sender)"}  ${message.subject ?? "(no subject)"}`,
      );
      // The id, so `conflict` can be pointed at a draft without a second lookup.
      if (message.isDraft) say(`            id: ${message.id}`);
    }
    say();
  }
}

/**
 * Times how long Exchange takes to show Graph a change made elsewhere.
 *
 * This is the deliverable that decides Part B. It polls hard - every two seconds
 * - because the number wanted is Exchange's own propagation delay, not the
 * platform's 20-second UI interval. The UI latency is the sum of the two, and
 * saying so honestly needs them measured apart.
 */
async function watch(
  folderId: string,
  needle: string,
  mode: "appear" | "vanish",
): Promise<void> {
  const POLL_MS = 2_000;
  const TIMEOUT_MS = 5 * 60_000;

  const matches = (messages: MessageSummary[]): MessageSummary | undefined =>
    messages.find((m) => (m.subject ?? "").toLowerCase().includes(needle.toLowerCase()));

  const read = async (): Promise<MessageSummary[]> => {
    const page = await service.listConversations(folderId);
    return page.conversations.flatMap((c) => c.messages);
  };

  const before = matches(await read());
  say(`Watching ${folderId} for a subject containing "${needle}" to ${mode}.`);
  say(
    before === undefined
      ? "Not present right now."
      : `Present right now: ${before.subject ?? "(no subject)"}`,
  );

  if (mode === "appear" && before !== undefined) {
    fail("It is already there. Move or rename it first, or watch for it to vanish.");
  }
  if (mode === "vanish" && before === undefined) {
    fail("It is not there to begin with. Nothing to watch.");
  }

  say("Do the thing in Outlook now. Timing starts... now.");
  const started = Date.now();

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));

    let found: MessageSummary | undefined;
    try {
      found = matches(await read());
    } catch (error) {
      // A throttle or a blip mid-watch is not a result. Keep waiting; the
      // elapsed clock keeps running, which is the honest thing to report.
      say(`   (read failed, still watching: ${isMailError(error) ? error.kind : "unknown"})`);
      continue;
    }

    const done = mode === "appear" ? found !== undefined : found === undefined;
    const elapsed = Date.now() - started;

    if (done) {
      say();
      say(`${mode.toUpperCase()} after ${(elapsed / 1000).toFixed(1)}s of Exchange propagation.`);
      say(
        `In the platform a user would see it up to 20s later than that, ` +
          "because the pane polls on a 20s interval while the tab is focused.",
      );
      return;
    }

    if (elapsed > TIMEOUT_MS) {
      fail(`Gave up after ${(elapsed / 1000).toFixed(0)}s. It never ${mode}ed.`);
    }

    if (elapsed % 20_000 < POLL_MS) say(`   ...${(elapsed / 1000).toFixed(0)}s`);
  }
}

/**
 * Proves the concurrent-edit detection end to end, without Outlook.
 *
 * Outlook is the case that matters and a human has to drive it, but the
 * mechanism being relied on is "a changeKey the editor last saw no longer
 * matches the one in Exchange" - and that is reproducible from here by making
 * the change ourselves. If this refuses, the Outlook case refuses for the same
 * reason and by the same code path.
 */
async function conflict(draftId: string): Promise<void> {
  const opened = await service.getDraftForEdit(draftId);

  if (!isZzTestSubject(opened.subject)) {
    fail(
      `Refusing: "${opened.subject}" is not a ZZTEST subject. ` +
        "This command writes to the draft, so it will only touch a fixture.",
    );
  }

  const staleKey = opened.changeKey;
  say(`Draft: ${opened.subject}`);
  say(`changeKey held by the "editor": ${staleKey}`);

  // Somebody else edits it. Unconditional - no expectedChangeKey - which is
  // exactly what Outlook does, since Outlook has never heard of our editor.
  const after = await service.updateDraft(draftId, {
    subject: `${opened.subject} (edited underneath)`,
  });
  say(`changeKey after the outside edit:  ${after.changeKey}`);

  if (after.changeKey === staleKey) {
    fail(
      "Exchange did not change the changeKey on a write. Conflict detection " +
        "cannot work on this mailbox and the design needs revisiting.",
    );
  }

  // Now the editor saves what it was holding. This must be refused.
  try {
    await service.updateDraft(draftId, {
      subject: `${opened.subject} (editor would have overwritten)`,
      expectedChangeKey: staleKey,
    });
    fail("NOT REFUSED. The editor overwrote an outside edit. This is the bug.");
  } catch (error) {
    if (isMailError(error) && error.kind === "conflict") {
      say();
      say("REFUSED with kind=conflict, as designed. The outside edit survives.");
    } else {
      fail(`Refused, but with the wrong failure: ${String(error)}`);
    }
  }

  // Put the subject back, so the fixture is reusable.
  const current = await service.getDraftForEdit(draftId);
  await service.updateDraft(draftId, {
    subject: opened.subject ?? "",
    expectedChangeKey: current.changeKey,
  });
  say(`Subject restored to: ${opened.subject}`);
}

/**
 * Measures how long a change written through Graph takes to show up in a folder
 * LISTING, which is the read the message pane actually makes.
 *
 * The distinction matters and is easy to skip. Re-reading the message you just
 * wrote proves nothing about propagation - `updateDraft` already re-reads, and
 * that read is served consistently. What the pane does is list the folder, and a
 * folder listing is a different index. This edits a ZZTEST draft and then polls
 * the listing until the change appears there.
 *
 * It is the platform-initiated half of the sync matrix. The Outlook-initiated
 * half needs a person and is what `watch` is for.
 */
async function propagate(draftId: string): Promise<void> {
  const original = await service.getDraftForEdit(draftId);

  if (!isZzTestSubject(original.subject)) {
    fail(`Refusing: "${original.subject}" is not a ZZTEST subject.`);
  }

  const message = await service.getMessage(draftId);
  const folderId = message.parentFolderId;
  if (folderId === null) fail("The draft reports no parent folder; cannot poll a listing.");

  const marker = `probe-${Date.now().toString(36)}`;
  const probed = `${original.subject} ${marker}`;

  say(`Draft:  ${original.subject}`);
  say(`Marker: ${marker}`);

  const written = await timed(() =>
    service.updateDraft(draftId, {
      subject: probed,
      expectedChangeKey: original.changeKey,
    }),
  );
  say(`PATCH + re-read returned in ${written.ms}ms.`);

  const started = Date.now();
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const page = await service.listConversations(folderId);
    const seen = page.conversations
      .flatMap((c) => c.messages)
      .some((m) => (m.subject ?? "").includes(marker));

    if (seen) {
      say(
        `Visible in the folder LISTING after ${Date.now() - started}ms ` +
          `(${attempts} listing read${attempts === 1 ? "" : "s"}).`,
      );
      break;
    }

    if (Date.now() - started > 60_000) fail("Not visible in the listing after 60s.");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const current = await service.getDraftForEdit(draftId);
  await service.updateDraft(draftId, {
    subject: original.subject ?? "",
    expectedChangeKey: current.changeKey,
  });
  say(`Subject restored to: ${original.subject}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "survey":
      return survey();
    case "groups":
      if (args[0] === undefined) fail("Usage: groups <folderId>");
      return groups(args[0]);
    case "watch": {
      const [folderId, needle, mode] = args;
      if (folderId === undefined || needle === undefined) {
        fail("Usage: watch <folderId> <needle> appear|vanish");
      }
      if (mode !== "appear" && mode !== "vanish") {
        fail("The mode must be `appear` or `vanish`.");
      }
      return watch(folderId, needle, mode);
    }
    case "conflict":
      if (args[0] === undefined) fail("Usage: conflict <draftId>");
      return conflict(args[0]);
    case "propagate":
      if (args[0] === undefined) fail("Usage: propagate <draftId>");
      return propagate(args[0]);
    default:
      fail(
        "Commands: survey | groups <folderId> | watch <folderId> <needle> appear|vanish " +
          "| conflict <draftId> | propagate <draftId>",
      );
  }
}

void main().catch((error: unknown) => {
  if (isMailError(error)) {
    fail(`MailError(${error.kind}): ${error.detail ?? error.userMessage}`);
  }
  fail(String(error));
});

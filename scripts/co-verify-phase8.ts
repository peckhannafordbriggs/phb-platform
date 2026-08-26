// FIRST, and it has to be: lib/env.ts parses process.env at import time, so the
// environment must be loaded before any import below is evaluated. See load-env.ts.
import "./load-env";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mailService } from "../lib/modules/change-orders/mail/service";
import { isZzTestSubject } from "../lib/modules/change-orders/mail/guards";
import { isMailError } from "../lib/modules/change-orders/mail/errors";
import type {
  MailFolderSummary,
  MessageDetail,
} from "../lib/modules/change-orders/mail/types";

/**
 * Phase 8 verification, against the live changeorder@phb1899.com mailbox.
 *
 * Why this exists rather than a test: every Graph phase so far found defects that
 * a mocked transport agreed with - `wellKnownName` not existing in v1.0, Projects
 * sitting at depth 2, mail paging with `$skip` and not `$skiptoken`, Exchange
 * rewriting U+00A0 as `&nbsp;`, Outlook writing a pasted cell as `<td><p>`.
 * Writes have more surface than reads and Phase 8 adds five kinds of them, so
 * every claim it makes about Exchange's behaviour is checked here.
 *
 * What this script CANNOT do, structurally:
 *
 *  - Send anything. There is no call to sendDraft anywhere in it, and
 *    PHB_ALLOW_SEND is not read, set or mentioned. Every operation below either
 *    creates an unsent draft or is reversible in Exchange.
 *  - Touch a message that is not a ZZTEST. Every write goes through the service,
 *    which reads the subject from Exchange and applies the fence. This script
 *    checks the same thing before asking, so a mistake is a clear refusal here
 *    rather than a MailError from three frames down.
 *
 * Usage:
 *
 *   npx tsx scripts/co-verify-phase8.ts survey
 *       Lists the ZZTEST messages and the folder tree. Read-only. Start here.
 *
 *   npx tsx scripts/co-verify-phase8.ts respond <messageId>
 *       createReply, createReplyAll and createForward against one ZZTEST message.
 *       Creates three drafts. Reports threading, quoting, recipients, attachments.
 *
 *   npx tsx scripts/co-verify-phase8.ts compose
 *       Creates an empty draft and edits it from genuinely empty.
 *
 *   npx tsx scripts/co-verify-phase8.ts move <messageId> <destinationFolderId>
 *       Moves it, then proves the id still resolves afterwards.
 *
 *   npx tsx scripts/co-verify-phase8.ts delete <messageId>
 *       Deletes it, then proves it is in Deleted Items.
 *
 *   npx tsx scripts/co-verify-phase8.ts attachments <draftId> [fileToAdd]
 *       Downloads each existing attachment and reports its SHA-256, then adds
 *       the file if one is given, then removes it again - checking at each step
 *       that the pre-existing attachments are still there.
 */

/**
 * The memoised process-wide service, so the token cache behind it is shared
 * across every request this script makes.
 *
 * Built at import time, which means a missing credential fails here rather than
 * part-way through a subcommand. That is the right trade for a verification
 * script: every subcommand needs it.
 */
const service = mailService();

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function heading(text: string): void {
  say("");
  say(`=== ${text} ===`);
}

/** A checked observation. The point of the script is the FAIL lines. */
let failures = 0;

function check(passed: boolean, claim: string, detail = ""): void {
  if (!passed) failures += 1;
  say(
    `  ${passed ? "PASS" : "FAIL"}  ${claim}${detail.length > 0 ? ` — ${detail}` : ""}`,
  );
}

function note(text: string): void {
  say(`        ${text}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Refuses before asking Graph, so a mistyped id that happens to name a real
 * change order is a message from this script rather than a service refusal.
 */
async function requireZzTest(messageId: string): Promise<MessageDetail> {
  const message = await service.getMessage(messageId);

  if (!isZzTestSubject(message.subject)) {
    throw new Error(
      `Refusing to act on "${message.subject ?? "(no subject)"}": not a ZZTEST ` +
        `message. This script only ever touches ZZTEST mail.`,
    );
  }

  return message;
}

function describeFolder(folder: MailFolderSummary, byId: Map<string, MailFolderSummary>): string {
  const path: string[] = [folder.displayName];
  let parent = folder.parentFolderId;
  while (parent !== null && byId.has(parent)) {
    const next = byId.get(parent)!;
    path.unshift(next.displayName);
    parent = next.parentFolderId;
  }
  return path.join(" / ");
}

// --------------------------------------------------------------------- survey

async function survey(): Promise<void> {
  heading("Folders");
  const folders = await service.listFolders();
  const byId = new Map(folders.map((f) => [f.id, f]));

  for (const folder of folders) {
    say(
      `  ${describeFolder(folder, byId).padEnd(60)} ${String(folder.totalItemCount).padStart(4)} items  ${folder.id}`,
    );
  }
  note(`${folders.length} folders.`);

  heading("ZZTEST messages");
  /**
   * Searched rather than filtered. `$search` is not `$filter`, returns by
   * relevance rather than date, and cannot be combined with `$orderby` - all
   * three are fine here, because this is a survey and not a list view.
   */
  const wellKnown = ["inbox", "drafts", "sentitems"];
  for (const alias of wellKnown) {
    const page = await service.searchMessages(alias, "ZZTEST", { top: 25 });
    const relevant = page.messages.filter((m) => isZzTestSubject(m.subject));

    say(`  ${alias}: ${relevant.length} ZZTEST message(s)`);
    for (const message of relevant) {
      say(
        `    ${message.isDraft ? "DRAFT" : "     "} ${message.hasAttachments ? "ATT" : "   "} ${message.subject ?? "(no subject)"}`,
      );
      note(`id: ${message.id}`);
      if (message.hasAttachments) {
        for (const attachment of await service.listAttachments(message.id)) {
          note(
            `  attachment: ${attachment.name ?? "(unnamed)"} ` +
              `${attachment.sizeBytes ?? "?"} bytes ${attachment.contentType ?? ""} ` +
              `id=${attachment.id}`,
          );
        }
      }
    }
  }
}

// -------------------------------------------------------------------- respond

async function respond(messageId: string): Promise<void> {
  const source = await requireZzTest(messageId);

  heading("Source message");
  say(`  subject:        ${source.subject}`);
  say(`  conversationId: ${source.conversationId}`);
  say(`  from:           ${source.from?.address ?? "(none)"}`);
  say(`  to:             ${source.to.map((a) => a.address).join(", ") || "(none)"}`);
  say(`  cc:             ${source.cc.map((a) => a.address).join(", ") || "(none)"}`);
  say(`  attachments:    ${source.hasAttachments ? "yes" : "no"}`);

  const sourceAttachments = source.hasAttachments
    ? await service.listAttachments(messageId)
    : [];
  for (const attachment of sourceAttachments) {
    note(`original attachment: ${attachment.name} (${attachment.sizeBytes} bytes)`);
  }

  const created: string[] = [];

  for (const mode of ["reply", "replyAll", "forward"] as const) {
    heading(`createDerivedDraft: ${mode}`);

    const draft =
      mode === "reply"
        ? await service.createReplyDraft(messageId)
        : mode === "replyAll"
          ? await service.createReplyAllDraft(messageId)
          : await service.createForwardDraft(messageId);

    created.push(draft.id);
    say(`  draft id: ${draft.id}`);
    say(`  subject:  ${draft.subject}`);
    say(`  to:       ${draft.to.map((a) => a.address).join(", ") || "(none)"}`);
    say(`  cc:       ${draft.cc.map((a) => a.address).join(", ") || "(none)"}`);

    /**
     * Threading. The load-bearing check in this whole script: Intake 6 matches
     * replies by conversation ID, so a derived draft on a different conversation
     * breaks the automation's filing silently.
     */
    const detail = await service.getMessage(draft.id);
    check(
      detail.conversationId === source.conversationId,
      "conversationId matches the source",
      `${detail.conversationId} vs ${source.conversationId}`,
    );

    // Quoting. Exchange writes it; if this is absent the reply is not a reply.
    const quoted =
      draft.body.length > 0 &&
      (draft.body.includes("From:") ||
        draft.body.includes("wrote:") ||
        draft.body.includes("-----Original") ||
        draft.body.toLowerCase().includes("<blockquote"));
    check(quoted, "the original is quoted in the body", `${draft.body.length} bytes`);

    // The subject Exchange chose, and whether the fence accepts it. This is the
    // reason isZzTestSubject skips RE:/FW: - see docs/runbook.md.
    check(
      isZzTestSubject(draft.subject),
      "the derived subject is inside the ZZTEST fence",
      draft.subject ?? "(none)",
    );

    // The editor needs something to edit.
    check(
      draft.segments.length > 0,
      "the draft has editable text segments",
      `${draft.segments.length} segments`,
    );

    if (mode === "replyAll") {
      const recipients = new Set(
        [...draft.to, ...draft.cc].map((a) => a.address.toLowerCase()),
      );
      note(`reply-all recipients: ${[...recipients].join(", ")}`);
      note(
        "Check by eye that these are the original sender plus everyone on To and Cc, " +
          "minus the mailbox itself.",
      );
    }

    if (mode === "forward") {
      const forwarded = await service.listAttachments(draft.id);
      note(
        `forwarded attachments: ${forwarded.map((a) => `${a.name} (${a.sizeBytes})`).join(", ") || "(none)"}`,
      );
      // PHASE-8: "the original attachments come along by default. Verify that
      // rather than assuming it."
      check(
        forwarded.length === sourceAttachments.length,
        "the forward carries the same number of attachments as the original",
        `${forwarded.length} vs ${sourceAttachments.length}`,
      );

      /**
       * Compared by CONTENT, not by the reported size.
       *
       * This check used to require `size` to match too, and failed against the
       * live mailbox: Exchange reported the forwarded copy as 5 bytes larger
       * than the original while the bytes were identical. `size` includes
       * per-attachment overhead and is not preserved across a copy - see the
       * download check below. A hash is the only thing that answers "is this the
       * same file", and it is the question worth asking.
       */
      for (const original of sourceAttachments) {
        const match = forwarded.find((f) => f.name === original.name);
        if (match === undefined) {
          check(false, `the forward carries "${original.name}"`, "no attachment of that name");
          continue;
        }

        const [before, after] = await Promise.all([
          service.downloadAttachment(messageId, original.id),
          service.downloadAttachment(draft.id, match.id),
        ]);

        const beforeDigest = sha256(before.bytes);
        const afterDigest = sha256(after.bytes);

        check(
          beforeDigest === afterDigest,
          `the forward carries "${original.name}" byte for byte`,
          `${after.bytes.byteLength} bytes, sha256 ${afterDigest.slice(0, 16)}…`,
        );

        if (match.sizeBytes !== original.sizeBytes) {
          note(
            `Graph reports size ${original.sizeBytes} on the original and ` +
              `${match.sizeBytes} on the copy. Expected: that field is not the ` +
              `content length. Content is identical.`,
          );
        }
      }
    }
  }

  heading("Drafts this run created");
  for (const id of created) say(`  ${id}`);
  note("They are unsent drafts in Drafts. Delete them in Outlook, or with:");
  note(`  npx tsx scripts/co-verify-phase8.ts delete <id>`);
}

// -------------------------------------------------------------------- compose

async function compose(): Promise<void> {
  heading("createDraft from scratch");

  const subject = `ZZTEST phase 8 compose ${new Date().toISOString()}`;
  const draft = await service.createDraft({ subject });

  say(`  draft id: ${draft.id}`);
  say(`  subject:  ${draft.subject}`);

  check(draft.subject === subject, "the subject was stored byte for byte");
  check(draft.body.length === 0, "the body is genuinely empty", `${draft.body.length} bytes`);
  check(draft.segments.length === 0, "there are no text segments to splice");
  check(draft.bodyFormat === "html", "the body format is html", draft.bodyFormat);

  /**
   * PHASE-8: "An empty body has no text segments to splice, so the editor needs a
   * sensible starting state - this is the case the 'add a paragraph' affordance
   * was built for. Check it works from genuinely empty."
   */
  heading("appendNote from genuinely empty");
  const edited = await service.updateDraft(draft.id, {
    appendNote: "First sentence, written into an empty draft.",
    expectedChangeKey: draft.changeKey,
  });

  say(`  body now: ${edited.body.slice(0, 200)}`);
  check(edited.body.length > 0, "the body is no longer empty");
  check(
    edited.body.includes("First sentence, written into an empty draft."),
    "the appended paragraph is in the stored body",
  );
  check(
    edited.segments.length > 0,
    "the editor now has a segment to edit",
    `${edited.segments.length} segments`,
  );

  heading("editing that segment by splice");
  const segment = edited.segments[0];
  if (segment === undefined) {
    check(false, "there is a segment to edit");
    return;
  }

  const respliced = await service.updateDraft(edited.id, {
    bodyEdits: [{ id: segment.id, text: "Replaced text, spliced in place." }],
    expectedChangeKey: edited.changeKey,
  });

  say(`  body now: ${respliced.body.slice(0, 200)}`);
  check(
    respliced.body.includes("Replaced text, spliced in place."),
    "the spliced edit is in the stored body",
  );
  check(
    !respliced.body.includes("First sentence, written into an empty draft."),
    "the original text was replaced rather than duplicated",
  );

  heading("Draft this run created");
  say(`  ${draft.id}`);
  note("An unsent draft. Delete it in Outlook, or with the delete subcommand.");
}

// ----------------------------------------------------------------------- move

async function move(messageId: string, destinationFolderId: string): Promise<void> {
  const before = await requireZzTest(messageId);

  const folders = await service.listFolders();
  const byId = new Map(folders.map((f) => [f.id, f]));
  const destination = byId.get(destinationFolderId);

  heading("Before the move");
  say(`  subject:      ${before.subject}`);
  say(`  id:           ${messageId}`);
  say(`  in folder:    ${before.parentFolderId}`);
  say(
    `  destination:  ${destination === undefined ? "(not in the tree)" : describeFolder(destination, byId)}`,
  );

  if (destination === undefined) {
    check(false, "the destination folder is in the tree", destinationFolderId);
    return;
  }

  heading("moveMessage");
  const result = await service.moveMessage(messageId, destinationFolderId);

  say(`  returned id:  ${result.id}`);
  say(`  previous id:  ${result.previousId}`);
  say(`  idChanged:    ${result.idChanged}`);

  /**
   * PHASE-8: "The message gets a new ID unless immutable IDs are in use - they
   * are, on every request, so the ID survives. Verify that against the live
   * mailbox rather than trusting it."
   */
  check(!result.idChanged, "the id survived the move (immutable ids in effect)");
  check(result.id === messageId, "the returned id is the id we started with");

  heading("The id still resolves afterwards");
  const after = await service.getMessage(messageId);
  say(`  subject:   ${after.subject}`);
  say(`  in folder: ${after.parentFolderId}`);

  check(
    after.parentFolderId === destinationFolderId,
    "the message is now in the destination folder",
    `${after.parentFolderId} vs ${destinationFolderId}`,
  );
  note(
    `Now check in Outlook that it appears under ${describeFolder(destination, byId)}.`,
  );
  note(`To put it back: npx tsx scripts/co-verify-phase8.ts move ${messageId} ${before.parentFolderId}`);
}

// --------------------------------------------------------------------- delete

async function remove(messageId: string): Promise<void> {
  const before = await requireZzTest(messageId);

  heading("Before the delete");
  say(`  subject:   ${before.subject}`);
  say(`  in folder: ${before.parentFolderId}`);

  heading("deleteMessage");
  const result = await service.deleteMessage(messageId);
  say(`  reported subject: ${result.subject}`);

  heading("It went to Deleted Items, not to the dumpster");
  const deletedItems = await service.getFolder("deleteditems");
  say(`  Deleted Items id: ${deletedItems.id}`);
  note(
    "This is the check that caught the original implementation: DELETE " +
      "/messages/{id} put the message in Recoverable Items \\ Deletions, not here.",
  );

  /**
   * The claim being checked is that DELETE is a SOFT delete. If this ever fails,
   * something has started permanently deleting mail and that is an emergency.
   */
  try {
    const after = await service.getMessage(messageId);
    check(
      after.parentFolderId === deletedItems.id,
      "the message is now in Deleted Items",
      `${after.parentFolderId} vs ${deletedItems.id}`,
    );
    note("It is still addressable by the same immutable id, from the bin.");
    note(`To recover it: npx tsx scripts/co-verify-phase8.ts move ${messageId} ${before.parentFolderId}`);
  } catch (error) {
    if (isMailError(error) && error.kind === "not_found") {
      check(
        false,
        "the message is still readable in Deleted Items",
        "it answered not_found - if this is not a draft, something PERMANENTLY deleted it",
      );
      note(
        "Drafts are the known exception worth checking by eye in Outlook before " +
          "treating this as a defect.",
      );
    } else {
      throw error;
    }
  }
}

// ---------------------------------------------------------------- attachments

async function attachments(draftId: string, fileToAdd?: string): Promise<void> {
  await requireZzTest(draftId);

  heading("Existing attachments");
  const before = await service.listAttachments(draftId);
  if (before.length === 0) {
    note("None. Add one in Outlook first, or this proves nothing about survival.");
  }

  const fingerprints = new Map<string, string>();
  for (const attachment of before) {
    say(
      `  ${attachment.name ?? "(unnamed)"}  ${attachment.sizeBytes ?? "?"} bytes  ${attachment.contentType ?? ""}`,
    );

    /**
     * Downloaded and hashed rather than merely listed. PHASE-8 asks that a
     * downloaded attachment match the original byte for byte, and a SHA-256 is
     * how that is checked against the copy on disk without this script needing
     * to hold the original.
     */
    const file = await service.downloadAttachment(draftId, attachment.id);
    const digest = sha256(file.bytes);
    fingerprints.set(attachment.id, digest);

    note(`downloaded as: ${file.name}  ${file.contentType}`);
    note(`bytes: ${file.bytes.byteLength}  sha256: ${digest}`);
    /**
     * `size` is NOT the content length, and this check used to assert that it
     * was. Measured against the live mailbox: a 337,145-byte PDF is reported by
     * Graph as `size: 337527` on the message it arrived on, and `size: 337532`
     * on a forward of that same message - while the content bytes are identical
     * both times. So `size` carries per-attachment storage overhead (382 bytes
     * here, 387 after the copy) and is not stable across a copy.
     *
     * The honest assertion is therefore a bound, not an equality: the content
     * must be non-empty and must not exceed what Exchange reported. Anything
     * about the CONTENT is proved by the SHA-256, which is what the caller
     * compares against the original file.
     */
    const reported = attachment.sizeBytes ?? 0;
    check(
      file.bytes.byteLength > 0 && file.bytes.byteLength <= reported,
      "the content is non-empty and within the size Exchange reported",
      `${file.bytes.byteLength} content bytes, ${reported} reported ` +
        `(${reported - file.bytes.byteLength} bytes of overhead)`,
    );
    note("Compare that sha256 against the original file with:");
    note(`  certutil -hashfile "<original>" SHA256`);
  }

  if (fileToAdd === undefined) {
    note("");
    note("No file given, so nothing was added or removed. Pass a path to test those.");
    return;
  }

  heading(`Adding ${fileToAdd}`);
  const bytes = new Uint8Array(await readFile(fileToAdd));
  const name = fileToAdd.split(/[/\\]/).pop() ?? "attachment";
  const localDigest = sha256(bytes);

  say(`  ${name}  ${bytes.byteLength} bytes  sha256 ${localDigest}`);

  const afterAdd = await service.addDraftAttachment(draftId, {
    name,
    // Left to the service's own default rather than guessed here.
    contentType: "",
    bytes,
  });

  for (const attachment of afterAdd) {
    say(`  now present: ${attachment.name} (${attachment.sizeBytes} bytes) id=${attachment.id}`);
  }

  /**
   * PHASE-8: "Verify an existing attachment survives when a second is added."
   * The one that matters - a draft the automation created carries attachments
   * downstream flows expect.
   */
  for (const original of before) {
    check(
      afterAdd.some((a) => a.id === original.id),
      `the pre-existing attachment "${original.name}" survived the add`,
    );
  }
  check(
    afterAdd.length === before.length + 1,
    "exactly one attachment was added",
    `${before.length} -> ${afterAdd.length}`,
  );

  const added = afterAdd.find((a) => !before.some((b) => b.id === a.id));
  if (added === undefined) {
    check(false, "the added attachment is identifiable");
    return;
  }

  heading("Round-tripping the file just added");
  const downloaded = await service.downloadAttachment(draftId, added.id);
  const roundTripped = sha256(downloaded.bytes);
  say(`  sha256 out: ${roundTripped}`);
  say(`  sha256 in:  ${localDigest}`);
  check(
    roundTripped === localDigest,
    "the attachment came back byte for byte identical",
  );

  heading("Removing it again");
  const afterRemove = await service.removeDraftAttachment(draftId, added.id);
  for (const attachment of afterRemove) {
    say(`  still present: ${attachment.name} id=${attachment.id}`);
  }

  // PHASE-8: "Remove an attachment; the others survive."
  for (const original of before) {
    check(
      afterRemove.some((a) => a.id === original.id),
      `the pre-existing attachment "${original.name}" survived the remove`,
    );
  }
  check(
    afterRemove.length === before.length,
    "the draft is back to the attachments it started with",
    `${afterRemove.length} vs ${before.length}`,
  );

  heading("The originals are still byte-identical after all of that");
  for (const original of before) {
    const again = await service.downloadAttachment(draftId, original.id);
    check(
      sha256(again.bytes) === fingerprints.get(original.id),
      `"${original.name}" is unchanged`,
    );
  }
}

// ------------------------------------------------------------------------ cli

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  say(`Phase 8 verification against the live mailbox.`);
  say(`This script never sends. PHB_ALLOW_SEND is neither read nor set here.`);

  switch (command) {
    case "survey":
      await survey();
      break;
    case "respond":
      if (args[0] === undefined) throw new Error("respond needs a messageId");
      await respond(args[0]);
      break;
    case "compose":
      await compose();
      break;
    case "move":
      if (args[0] === undefined || args[1] === undefined) {
        throw new Error("move needs a messageId and a destinationFolderId");
      }
      await move(args[0], args[1]);
      break;
    case "delete":
      if (args[0] === undefined) throw new Error("delete needs a messageId");
      await remove(args[0]);
      break;
    case "attachments":
      if (args[0] === undefined) throw new Error("attachments needs a draftId");
      await attachments(args[0], args[1]);
      break;
    default:
      say("");
      say("Read the comment at the top of this file. Subcommands:");
      say("  survey | respond <id> | compose | move <id> <folderId>");
      say("  delete <id> | attachments <draftId> [fileToAdd]");
      process.exitCode = 1;
      return;
  }

  heading("Result");
  if (failures === 0) {
    say("  Every checked claim held.");
  } else {
    say(`  ${failures} checked claim(s) FAILED. Read the FAIL lines above.`);
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  say("");
  if (isMailError(error)) {
    say(`MailError(${error.kind}): ${error.userMessage}`);
    if (error.detail !== null) say(`  detail: ${error.detail}`);
  } else {
    say(String(error));
  }
  process.exitCode = 1;
});

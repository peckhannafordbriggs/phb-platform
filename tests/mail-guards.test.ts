import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSendAllowed,
  assertWriteAllowed,
  isZzTestSubject,
} from "@/lib/modules/change-orders/mail/guards";
import { createMailService } from "@/lib/modules/change-orders/mail/service";
import { createGraphStub, jsonResponse } from "./graph-stub";

/**
 * The development guards.
 *
 * Development runs against the live changeorder@phb1899.com mailbox and there is
 * no test mailbox - so these are the tests that matter most in this phase. The
 * negative case is the point: docs/07-conventions.md, "the test that matters is
 * that an ungranted request is rejected".
 *
 * NODE_ENV is "test" throughout, so the non-production branch is the one under
 * test unless a case stubs otherwise.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // vi.stubEnv restores on unstub, but be explicit: nothing may leave the send
  // gate open for the next file.
  process.env.PHB_ALLOW_SEND = "false";
});

function silenceLogs(): void {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("PHB_ALLOW_SEND", () => {
  it("throws when unset", () => {
    silenceLogs();
    vi.stubEnv("PHB_ALLOW_SEND", undefined);

    expect(() => assertSendAllowed("ZZTEST anything", "send")).toThrowError(
      expect.objectContaining({ kind: "send_not_allowed" }) as unknown as Error,
    );
  });

  it("throws when false", () => {
    silenceLogs();
    vi.stubEnv("PHB_ALLOW_SEND", "false");

    expect(() => assertSendAllowed("ZZTEST anything", "send")).toThrowError(
      expect.objectContaining({ kind: "send_not_allowed" }) as unknown as Error,
    );
  });

  it("throws on anything that is not exactly \"true\"", () => {
    silenceLogs();

    for (const value of ["TRUE", "True", "1", "yes", "true ", ""]) {
      vi.stubEnv("PHB_ALLOW_SEND", value);
      expect(
        () => assertSendAllowed("ZZTEST anything", "send"),
        `PHB_ALLOW_SEND=${JSON.stringify(value)} must not open the gate`,
      ).toThrowError(
        expect.objectContaining({ kind: "send_not_allowed" }) as unknown as Error,
      );
    }
  });

  it("still applies the ZZTEST fence when the gate is open outside production", () => {
    silenceLogs();
    vi.stubEnv("PHB_ALLOW_SEND", "true");

    // Both guards, not either: an open send gate outside production must not
    // become a licence to send a real change-order draft.
    expect(() =>
      assertSendAllowed("[CO: Owner|Bulletin] real draft", "send"),
    ).toThrowError(
      expect.objectContaining({ kind: "write_not_allowed" }) as unknown as Error,
    );

    expect(() => assertSendAllowed("ZZTEST draft", "send")).not.toThrow();
  });
});

describe("the ZZTEST fence", () => {
  it("blocks a write to a message that is not a ZZTEST", () => {
    silenceLogs();

    expect(() =>
      assertWriteAllowed("[CO: Owner|Bulletin] CO 1234 pricing", "updateDraft"),
    ).toThrowError(
      expect.objectContaining({ kind: "write_not_allowed" }) as unknown as Error,
    );
  });

  it("blocks a write to a message with no subject", () => {
    silenceLogs();

    expect(() => assertWriteAllowed(null, "moveMessage")).toThrowError(
      expect.objectContaining({ kind: "write_not_allowed" }) as unknown as Error,
    );
  });

  it("blocks a subject that merely contains ZZTEST", () => {
    silenceLogs();

    // "begins with", not "contains" - otherwise a vendor could name a real
    // message so that the platform would write to it.
    for (const subject of [
      "Change order notes ZZTEST",
      "[CCHMC RFI 229] ZZTEST",
      "Please see ZZTEST attached",
      "XZZTEST",
    ]) {
      expect(
        () => assertWriteAllowed(subject, "updateDraft"),
        `${subject} must not be inside the fence`,
      ).toThrowError(
        expect.objectContaining({ kind: "write_not_allowed" }) as unknown as Error,
      );
    }
  });

  /**
   * Exchange's own reply and forward prefixes are skipped before the fence is
   * tested. This case used to be a blocked one, and changing it was a deliberate
   * decision rather than a drift.
   *
   * The reason: `createReply` names its draft "RE: <original>", so a reply to a
   * ZZTEST message is called "RE: ZZTEST ...". Without this, Phase 8 could create
   * a derived draft and then neither edit nor send it, which would make the whole
   * reply path unverifiable outside production - the one place where verifying it
   * matters, since production has no fence at all.
   *
   * What it does NOT do is widen the fence to real mail: a reply to an actual
   * change order is still refused, which is the case that protects the pipeline.
   */
  it("skips the reply and forward prefixes Exchange writes", () => {
    silenceLogs();

    for (const subject of [
      "RE: ZZTEST follow-up",
      "Re: ZZTEST follow-up",
      "re:ZZTEST follow-up",
      "FW: ZZTEST follow-up",
      "FWD: ZZTEST follow-up",
      "FW: RE: ZZTEST follow-up",
      "RE: RE: RE: ZZTEST thread",
    ]) {
      expect(
        () => assertWriteAllowed(subject, "updateDraft"),
        `${subject} is a derived ZZTEST draft and must be inside the fence`,
      ).not.toThrow();
    }
  });

  it("still refuses a reply to a real change order", () => {
    silenceLogs();

    // The case that protects the live pipeline. A reply prefix in front of a
    // real subject is still a real message.
    for (const subject of [
      "RE: [CCHMC RFI 229] New CO logged (Bid Tracker)",
      "FW: [CCHMC Bulletin 12] Change Order Request",
      "RE: CCHMC Liberty Expansion - Change Order Scope Request",
      // Not a prefix at all - the text has to be at the front to be skipped.
      "Notes RE: ZZTEST",
    ]) {
      expect(
        () => assertWriteAllowed(subject, "updateDraft"),
        `${subject} must not be inside the fence`,
      ).toThrowError(
        expect.objectContaining({ kind: "write_not_allowed" }) as unknown as Error,
      );
    }
  });

  it("permits a write to a ZZTEST message", () => {
    expect(() => assertWriteAllowed("ZZTEST draft for phase 4", "updateDraft")).not.toThrow();
    expect(() => assertWriteAllowed("  ZZTEST leading space", "updateDraft")).not.toThrow();
  });

  it("does not apply in production", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(() => assertWriteAllowed("A real change order", "updateDraft")).not.toThrow();
  });

  it("recognises the prefix predicate consistently", () => {
    expect(isZzTestSubject("ZZTEST x")).toBe(true);
    expect(isZzTestSubject("RE: ZZTEST x")).toBe(true);
    expect(isZzTestSubject("FW: FW: ZZTEST x")).toBe(true);
    expect(isZzTestSubject("RE: [CCHMC RFI 229] New CO logged")).toBe(false);
    expect(isZzTestSubject("zztest x")).toBe(false);
    expect(isZzTestSubject(null)).toBe(false);
    expect(isZzTestSubject("")).toBe(false);
  });
});

describe("the service reads the subject from Exchange, not from the caller", () => {
  it("blocks a write when the message in the mailbox is not a ZZTEST", async () => {
    silenceLogs();
    const stub = createGraphStub(() =>
      jsonResponse({ id: "message-1", subject: "[CO: Owner|Bulletin] CO 1234" }),
    );

    await expect(
      createMailService(stub.transport).assertWritable("message-1", "updateDraft"),
    ).rejects.toMatchObject({ kind: "write_not_allowed" });

    // It asked Exchange what the subject is rather than trusting an argument.
    expect(stub.requests).toHaveLength(1);
    expect(decodeURIComponent(stub.requests[0]?.url ?? "")).toContain(
      "$select=id,subject",
    );
  });

  it("permits a write when the message in the mailbox is a ZZTEST", async () => {
    const stub = createGraphStub(() =>
      jsonResponse({ id: "message-1", subject: "ZZTEST phase 4 draft" }),
    );

    await expect(
      createMailService(stub.transport).assertWritable("message-1", "updateDraft"),
    ).resolves.toBeUndefined();
  });

  it("blocks a send regardless of the subject when the gate is shut", async () => {
    silenceLogs();
    vi.stubEnv("PHB_ALLOW_SEND", "false");

    const stub = createGraphStub(() =>
      jsonResponse({ id: "message-1", subject: "ZZTEST phase 4 draft" }),
    );

    await expect(
      createMailService(stub.transport).assertSendable("message-1", "sendDraft"),
    ).rejects.toMatchObject({ kind: "send_not_allowed" });
  });
});

describe("the write surface is exactly what has been authorised", () => {
  it("exposes only reads, guards, and the named writes", async () => {
    const { ChangeOrderMailService } = await import(
      "@/lib/modules/change-orders/mail/service"
    );

    const methods = Object.getOwnPropertyNames(
      ChangeOrderMailService.prototype,
    ).filter((name) => name !== "constructor");

    /**
     * The write surface is exactly what has been authorised, and nothing else.
     *
     * This assertion used to be "no write method exists at all", which was right
     * for Phases 4 and 5 and correctly failed the moment Phase 6 added editing
     * and sending. It is deliberately kept as an allowlist rather than deleted:
     * the value was never in the empty list, it is in having to come here and
     * NAME a new way of changing the mailbox before one can ship.
     *
     * Every entry below is one such decision. What each one may do:
     *
     *   updateDraft            - PATCHes named fields on a draft. Never attachments.
     *   sendDraft              - POSTs {id}/send on an existing draft. Never sendMail.
     *   createDraft            - a new empty draft. Cannot send it.
     *   createReplyDraft       - Graph createReply. Threading comes from Exchange.
     *   createReplyAllDraft    - Graph createReplyAll.
     *   createForwardDraft     - Graph createForward. Carries the originals.
     *   moveMessage            - {id}/move to one folder id. Reversible.
     *   deleteMessage          - DELETE {id}, i.e. to Deleted Items. Recoverable.
     *   addDraftAttachment     - one file, onto a draft only.
     *   removeDraftAttachment  - one attachment, off a draft only.
     *
     * Still absent, and not an oversight: anything resembling sendMail, anything
     * that sends more than one message, permanentDelete, copy, flag, category,
     * rule, and any bulk form of the above.
     */
    const AUTHORISED_WRITE_METHODS = [
      "updateDraft",
      "sendDraft",
      "createDraft",
      "createReplyDraft",
      "createReplyAllDraft",
      "createForwardDraft",
      "moveMessage",
      "deleteMessage",
      "addDraftAttachment",
      "removeDraftAttachment",
      /**
       * The private implementation the three createReply* methods share.
       *
       * It is listed because this assertion reads the prototype, and TypeScript's
       * `private` is a compile-time notion - so a private write method is still a
       * write method at runtime. Naming it is the honest outcome: it is one more
       * way the mailbox changes, and the point of this list is that every one of
       * them is written down.
       */
      "createDerivedDraft",
    ];

    const writes = methods
      .filter((name) =>
        /^(send|create|update|patch|put|move|delete|remove|reply|forward|copy|flag|add)/i.test(
          name,
        ),
      )
      .sort();

    expect(writes).toEqual([...AUTHORISED_WRITE_METHODS].sort());
  });

  it("has no method that permanently deletes anything", async () => {
    const { ChangeOrderMailService } = await import(
      "@/lib/modules/change-orders/mail/service"
    );

    // CLAUDE.md and docs/03: never expose permanentDelete. Not behind a
    // confirmation, not in an admin screen, nowhere. `deleteMessage` is
    // Exchange's soft delete and the message lands in Deleted Items.
    for (const name of Object.getOwnPropertyNames(
      ChangeOrderMailService.prototype,
    )) {
      expect(name.toLowerCase()).not.toContain("permanent");
      expect(name.toLowerCase()).not.toContain("purge");
      expect(name.toLowerCase()).not.toContain("harddelete");
    }
  });

  it("contains no permanentDelete anywhere in the module or its routes", async () => {
    const files = await changeOrderSourceFiles();
    const { readFile } = await import("node:fs/promises");

    expect(files.length).toBeGreaterThan(20);

    for (const file of files) {
      const source = await readFile(file, "utf8");

      expect(
        codeOnly(source),
        `${file} must not reference permanentDelete`,
      ).not.toContain("permanentDelete");
    }
  });

  it("still has no method that could send more than one message", async () => {
    const { ChangeOrderMailService } = await import(
      "@/lib/modules/change-orders/mail/service"
    );

    const methods = Object.getOwnPropertyNames(ChangeOrderMailService.prototype);

    // CLAUDE.md prohibition 1: no auto-send, bulk-send, send-all or scheduled
    // send, ever. One human, one draft, one deliberate action.
    for (const name of methods) {
      expect(name.toLowerCase(), `${name} looks like a bulk or automatic send`).not.toMatch(
        /(sendall|sendmany|sendbulk|bulksend|sendeach|schedulesend|sendlater|autosend)/,
      );
    }

    // sendDraft takes one id, not a list.
    expect(ChangeOrderMailService.prototype.sendDraft.length).toBeLessThanOrEqual(2);
  });

  it("contains no sendMail call anywhere in the change-orders module", async () => {
    const files = await changeOrderSourceFiles();
    const { readFile } = await import("node:fs/promises");

    expect(files.length).toBeGreaterThan(20);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(codeOnly(source), `${file} must not call sendMail`).not.toContain(
        "sendMail",
      );
    }
  });
});

/**
 * Every TypeScript source file in the change-orders module, its API routes and
 * its UI.
 *
 * Phase 8 widened this from the service directory alone. `sendMail` or
 * `permanentDelete` reached from a route handler would be exactly as fatal as
 * one reached from the service, and the routes are where a future phase is most
 * likely to reach for a shortcut.
 */
async function changeOrderSourceFiles(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const path = await import("node:path");

  const roots = [
    path.resolve(process.cwd(), "lib/modules/change-orders"),
    path.resolve(process.cwd(), "app/api/modules/change-orders"),
    path.resolve(process.cwd(), "app/(modules)/change-orders"),
  ];

  const found: string[] = [];
  for (const root of roots) {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      found.push(path.join(entry.parentPath ?? root, entry.name));
    }
  }
  return found;
}

/**
 * The source with comment lines removed.
 *
 * Naming a forbidden operation in a comment that forbids it is the only
 * legitimate use of the string, and this whole codebase does exactly that - so a
 * scan that did not strip comments would fail on the documentation of the rule.
 */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
}

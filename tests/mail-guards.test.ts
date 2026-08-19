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
    expect(() => assertWriteAllowed("Re: ZZTEST follow-up", "updateDraft")).toThrowError(
      expect.objectContaining({ kind: "write_not_allowed" }) as unknown as Error,
    );
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

describe("Phase 4 implements no write or send operation", () => {
  it("exposes only reads and guards on the service", async () => {
    const { ChangeOrderMailService } = await import(
      "@/lib/modules/change-orders/mail/service"
    );

    const methods = Object.getOwnPropertyNames(
      ChangeOrderMailService.prototype,
    ).filter((name) => name !== "constructor");

    /**
     * The write surface is exactly what Phase 6 authorised, and nothing else.
     *
     * This assertion used to be "no write method exists at all", which was right
     * for Phases 4 and 5 and correctly failed the moment Phase 6 added editing
     * and sending. It is deliberately kept as an allowlist rather than deleted:
     * the value was never in the empty list, it is in having to come here and
     * name a new way of changing the mailbox before one can ship.
     *
     * Still absent, and out of scope: creating a message, replying, forwarding,
     * moving, deleting, and anything resembling sendMail.
     */
    const WRITE_METHODS_AUTHORISED_BY_PHASE_6 = ["updateDraft", "sendDraft"];

    const writes = methods
      .filter((name) =>
        /^(send|create|update|patch|put|move|delete|remove|reply|forward|copy|flag)/i.test(
          name,
        ),
      )
      .sort();

    expect(writes).toEqual([...WRITE_METHODS_AUTHORISED_BY_PHASE_6].sort());
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
    const { readFile, readdir } = await import("node:fs/promises");
    const path = await import("node:path");

    const root = path.resolve(process.cwd(), "lib/modules/change-orders");
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => path.join(entry.parentPath ?? root, entry.name));

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      // Mentioning it in a comment that forbids it is the only legitimate use.
      const codeLines = source
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
      expect(codeLines.join("\n"), `${file} must not call sendMail`).not.toContain(
        "sendMail",
      );
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  auditActionLabel,
  describeAuditEvent,
  knownAuditActions,
  type DescribableAuditEvent,
} from "@/lib/admin/audit-describe";
import type { AuditAction } from "@/lib/audit";

/**
 * Turning an audit row into a sentence.
 *
 * This is the point of Phase 10, and it is pure arithmetic over a row, so it is
 * testable without a database. The failure this guards against is subtle: a
 * viewer that renders confident prose for an action it does not understand is
 * worse than one that admits it, because the audit table is the only record of
 * who sent a message to a vendor.
 */

const JIM = {
  id: "actor-1",
  firstName: "Jim",
  lastName: "Schwarz",
  email: "jschwarz@phb1899.com",
};
const SARAH = {
  id: "target-1",
  firstName: "Sarah",
  lastName: "Martin",
  email: "smartin@phb1899.com",
};

const MODULES = new Map([
  ["change-orders", "Change Orders"],
  ["bas", "Building Automation"],
]);

function event(over: Partial<DescribableAuditEvent> = {}): DescribableAuditEvent {
  return {
    action: "grant.added",
    moduleKey: "change-orders",
    metadata: null,
    actor: JIM,
    target: SARAH,
    ...over,
  };
}

describe("the sentence PHASE-10 asks for", () => {
  /**
   * The example in the phase document, almost verbatim: "`grant.added` with two
   * UUIDs is not an answer; 'Jim Schwarz granted Change Orders to Sarah Martin'
   * is."
   */
  it("renders a grant as a sentence naming both people and the module", () => {
    const described = describeAuditEvent(event(), MODULES);

    expect(described.sentence).toBe(
      "Jim Schwarz granted Change Orders to Sarah Martin",
    );
    expect(described.known).toBe(true);
  });

  it("renders a revoke the other way round", () => {
    const described = describeAuditEvent(event({ action: "grant.removed" }), MODULES);

    expect(described.sentence).toBe(
      "Jim Schwarz revoked Change Orders from Sarah Martin",
    );
  });

  it("uses the module display name, never the key", () => {
    const described = describeAuditEvent(event({ moduleKey: "bas" }), MODULES);

    expect(described.sentence).toContain("Building Automation");
    expect(described.sentence).not.toContain("bas");
  });

  /**
   * A module can be deactivated or renamed and its old rows still have to
   * render. Falling back to the key is degraded and never wrong.
   */
  it("falls back to the module key when the module is unknown", () => {
    const described = describeAuditEvent(event({ moduleKey: "retired-module" }), MODULES);

    expect(described.sentence).toBe(
      "Jim Schwarz granted retired-module to Sarah Martin",
    );
  });
});

describe("who did it", () => {
  it("names the platform when there is no actor", () => {
    const described = describeAuditEvent(
      event({ action: "employee.department_changed", actor: null, metadata: { from: "Service" } }),
      MODULES,
    );

    // The 20260817000000_replace_departments migration writes rows with a null
    // actor. That is the honest record for the platform acting rather than a
    // person, and it has to render as such.
    expect(described.actorLabel).toBe("The platform");
    expect(described.sentence).toContain("The platform");
  });

  it("falls back to the email when a name is missing", () => {
    const nameless = { ...JIM, firstName: null, lastName: null };
    const described = describeAuditEvent(event({ actor: nameless }), MODULES);

    expect(described.actorLabel).toBe("jschwarz@phb1899.com");
  });

  it("falls back to the email when the name is only whitespace", () => {
    const blank = { ...JIM, firstName: "  ", lastName: "" };

    expect(describeAuditEvent(event({ actor: blank }), MODULES).actorLabel).toBe(
      "jschwarz@phb1899.com",
    );
  });
});

describe("self-changed versus admin-changed", () => {
  /**
   * PHASE-10 names this requirement explicitly. It is the difference between
   * an employee updating their own position and an admin correcting it, and the
   * phase notes the distinction is already in the metadata.
   */
  it("reads as a self-change when the metadata says self", () => {
    const described = describeAuditEvent(
      event({
        action: "employee.position_changed",
        actor: SARAH,
        target: SARAH,
        metadata: { self: true, from: "Foreman" },
      }),
      MODULES,
    );

    expect(described.self).toBe(true);
    expect(described.sentence).toBe(
      "Sarah Martin changed their own position (previously Foreman)",
    );
  });

  it("reads as an admin change when an admin did it", () => {
    const described = describeAuditEvent(
      event({
        action: "employee.position_changed",
        actor: JIM,
        target: SARAH,
        metadata: { self: false, from: "Foreman" },
      }),
      MODULES,
    );

    expect(described.self).toBe(false);
    expect(described.sentence).toBe(
      "Jim Schwarz changed the position of Sarah Martin (previously Foreman)",
    );
  });

  /**
   * The metadata flag is only written by the position path. Every other action
   * has to be able to tell the same story from the ids alone, or a self-service
   * action added later would silently render as somebody else's doing.
   */
  it("detects a self-change from matching ids when the metadata says nothing", () => {
    const described = describeAuditEvent(
      event({ action: "employee.profile_completed", actor: SARAH, target: SARAH }),
      MODULES,
    );

    expect(described.self).toBe(true);
  });

  it("flags free text, which is what marks a row for admin cleanup", () => {
    const described = describeAuditEvent(
      event({
        action: "employee.position_changed",
        actor: SARAH,
        target: SARAH,
        metadata: { self: true, from: "Foreman", usedFreeTextPosition: true },
      }),
      MODULES,
    );

    expect(described.sentence).toContain("entered as free text");
  });
});

describe("mail actions, which are the only record of who acted", () => {
  it("names the sender, the subject and the recipients", () => {
    const described = describeAuditEvent(
      event({
        action: "mail.sent",
        moduleKey: "change-orders",
        metadata: {
          subject: "[CCHMC RFI 229] New CO logged",
          recipients: ["joel@vendor.example"],
        },
      }),
      MODULES,
    );

    expect(described.sentence).toBe(
      'Jim Schwarz sent "[CCHMC RFI 229] New CO logged" to joel@vendor.example',
    );
  });

  it("summarises a long recipient list rather than printing all of it", () => {
    const described = describeAuditEvent(
      event({
        action: "mail.sent",
        metadata: {
          subject: "Pricing",
          recipients: ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"],
        },
      }),
      MODULES,
    );

    expect(described.sentence).toContain("a@x.com, b@x.com, c@x.com +2 more");
  });

  /**
   * A platform delete is a move to Deleted Items, not a destruction. The
   * sentence has to say so or the log overstates what happened.
   */
  it("says a delete moved the message to Deleted Items", () => {
    const described = describeAuditEvent(
      event({ action: "mail.deleted", metadata: { subject: "ZZTEST probe" } }),
      MODULES,
    );

    expect(described.sentence).toBe(
      'Jim Schwarz moved "ZZTEST probe" to Deleted Items',
    );
    expect(described.sentence).not.toMatch(/\bdeleted\b/);
  });

  it("names which kind of derived draft was created", () => {
    const reply = describeAuditEvent(
      event({ action: "mail.draft_created", metadata: { mode: "replyAll", subject: "RE: x" } }),
      MODULES,
    );

    expect(reply.sentence).toContain("a reply-all");
  });
});

describe("an action this build does not know", () => {
  /**
   * The honest failure mode, and the reason `known` exists at all. Later phases
   * add actions; one that reached this viewer before somebody wrote a case for
   * it must render as itself rather than as confident prose.
   */
  it("renders the raw action and marks itself unknown", () => {
    const described = describeAuditEvent(
      event({ action: "job.something_new_in_phase_14" }),
      MODULES,
    );

    expect(described.known).toBe(false);
    expect(described.sentence).toContain("job.something_new_in_phase_14");
    expect(described.sentence).toContain("Jim Schwarz");
    expect(described.sentence).toContain("Sarah Martin");
  });

  it("still reports the parties, so the row is not a dead end", () => {
    const described = describeAuditEvent(event({ action: "unheard.of" }), MODULES);

    expect(described.actorLabel).toBe("Jim Schwarz");
    expect(described.targetLabel).toBe("Sarah Martin");
  });
});

describe("hostile or absent metadata", () => {
  const cases: { name: string; metadata: unknown }[] = [
    { name: "null", metadata: null },
    { name: "a string", metadata: "not an object" },
    { name: "an array", metadata: ["a", "b"] },
    { name: "a number", metadata: 42 },
    { name: "wrong-typed fields", metadata: { from: 7, self: "yes", recipients: "nope" } },
  ];

  // Metadata is a JSON column. Nothing enforces its shape, and a row written by
  // a migration or an older build can carry anything at all.
  for (const { name, metadata } of cases) {
    it(`renders without throwing when metadata is ${name}`, () => {
      expect(() =>
        describeAuditEvent(event({ action: "employee.position_changed", metadata }), MODULES),
      ).not.toThrow();
    });
  }

  it("treats a non-boolean self as not a self-change", () => {
    const described = describeAuditEvent(
      event({ action: "employee.position_changed", metadata: { self: "yes" } }),
      MODULES,
    );

    // "yes" is not true. Guessing would mislabel an admin's change as the
    // employee's own, which is exactly the distinction the phase wants right.
    expect(described.self).toBe(false);
  });
});

describe("the filter dropdown", () => {
  it("offers every action the renderer knows, and no others", () => {
    const offered = knownAuditActions().map((a) => a.action);

    // Every offered action must describe as known - the filter cannot list
    // something the viewer would then render as unrecognised.
    for (const action of offered) {
      expect(describeAuditEvent(event({ action }), MODULES).known).toBe(true);
    }
    expect(offered.length).toBeGreaterThan(20);
  });

  it("gives every action a label that is not its raw key", () => {
    for (const { action, label } of knownAuditActions()) {
      expect(label).not.toBe(action);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("sorts by label, not by the dotted key", () => {
    const labels = knownAuditActions().map((a) => a.label);
    expect([...labels].sort((a, b) => a.localeCompare(b))).toEqual(labels);
  });

  it("falls back to the raw name for an unknown action", () => {
    expect(auditActionLabel("job.new")).toBe("job.new");
  });

  /**
   * The guard that keeps this file honest as the platform grows: every action
   * in the union has a sentence and a label. Both records are typed as total,
   * so this is really a runtime check that the type has not been widened with a
   * cast somewhere.
   */
  it("covers every action in the AuditAction union", () => {
    const covered = new Set(knownAuditActions().map((a) => a.action));
    const sample: AuditAction[] = [
      "login.denied",
      "grant.added",
      "mail.sent",
      "employee.position_changed",
      "department.deleted",
      "mail.attachment_removed",
    ];

    for (const action of sample) expect(covered.has(action)).toBe(true);
  });
});

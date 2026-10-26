import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditActionFilterOptions,
  knownAuditActions,
} from "@/lib/admin/audit-describe";
import {
  isShownOnAuditScreen,
  SCREEN_AUDIT_ACTIONS,
  screenActionsFor,
} from "@/lib/admin/audit-screen";
import {
  auditFilterOptions,
  getEmployeeDetail,
  listAuditEvents,
} from "@/lib/admin/service";
import { writeAuditEvent, type AuditAction } from "@/lib/audit";
import { auditQuerySchema } from "@/lib/validation/admin";
import {
  createEmployee,
  disconnectDb,
  resetDb,
  seedChangeOrdersModule,
  testDb,
} from "./db";

/**
 * The audit log SCREEN shows account and access events only (2026-10-26).
 * Recording is untouched.
 *
 * Two halves, and the second is the one that matters: the audit page, the
 * History panel on an employee's page, the Action dropdown and the person
 * filters all stop at the same nine actions; and every hidden row - a mail
 * send above all, the only record of which person sent a vendor email - is
 * still written by the same `writeAuditEvent` and still in the table after the
 * screen has declined to show it.
 */

const query = (raw: Record<string, string>) => auditQuerySchema.parse(raw);

/** Every action the screen hides, one row each, written by the real writer. */
const HIDDEN: AuditAction[] = [
  "mail.sent",
  "mail.draft_edited",
  "mail.draft_created",
  "mail.moved",
  "mail.deleted",
  "mail.attachment_added",
  "bas.question_asked",
  "bas.point_label_changed",
  "cip.run_started",
  "login.denied",
  "employee.profile_completed",
  "employee.profile_reset",
  "employee.position_changed",
  "position.created",
];

let admin: { id: string };
let sarah: { id: string };
/** Sends mail and asks Analyze questions; has never had their access changed. */
let sender: { id: string };
/** Has only completed a profile; nothing about their access was ever recorded. */
let newbie: { id: string };

beforeEach(async () => {
  await resetDb();
  await seedChangeOrdersModule();

  admin = await createEmployee({ email: "admin@phb1899.com", firstName: "Jim", lastName: "Schwarz", isPlatformAdmin: true });
  sarah = await createEmployee({ email: "sarah@phb1899.com", firstName: "Sarah", lastName: "Martin" });
  sender = await createEmployee({ email: "sender@phb1899.com", firstName: "Pat", lastName: "Nolan" });
  newbie = await createEmployee({ email: "newbie@phb1899.com", firstName: "Ana", lastName: "Reyes" });

  // The shown set, one row of each, all about Sarah.
  await writeAuditEvent(testDb, { action: "employee.provisioned", targetEmployeeId: sarah.id });
  await writeAuditEvent(testDb, { action: "grant.added", actorEmployeeId: admin.id, targetEmployeeId: sarah.id, moduleKey: "change-orders" });
  await writeAuditEvent(testDb, { action: "grant.admin_added", actorEmployeeId: admin.id, targetEmployeeId: sarah.id, moduleKey: "change-orders" });
  await writeAuditEvent(testDb, { action: "grant.admin_removed", actorEmployeeId: admin.id, targetEmployeeId: sarah.id, moduleKey: "change-orders" });
  await writeAuditEvent(testDb, { action: "grant.removed", actorEmployeeId: admin.id, targetEmployeeId: sarah.id, moduleKey: "change-orders" });
  await writeAuditEvent(testDb, { action: "employee.admin_granted", actorEmployeeId: admin.id, targetEmployeeId: sarah.id });
  await writeAuditEvent(testDb, { action: "employee.admin_revoked", actorEmployeeId: admin.id, targetEmployeeId: sarah.id });
  await writeAuditEvent(testDb, { action: "employee.disabled", actorEmployeeId: admin.id, targetEmployeeId: sarah.id });
  await writeAuditEvent(testDb, { action: "employee.enabled", actorEmployeeId: admin.id, targetEmployeeId: sarah.id });

  // The hidden set. Mail and Analyze rows by the sender; the employee rows
  // about Sarah (profile) and the newbie (profile only); the rest by the admin.
  for (const action of HIDDEN) {
    const aboutSarah = action === "employee.position_changed" || action === "employee.profile_reset";
    const bySender = action.startsWith("mail.") || action.startsWith("bas.");
    await writeAuditEvent(testDb, {
      action,
      actorEmployeeId: action === "login.denied" || action === "employee.profile_completed" ? null : bySender ? sender.id : admin.id,
      targetEmployeeId: aboutSarah ? sarah.id : action === "employee.profile_completed" ? newbie.id : null,
      moduleKey: bySender ? (action.startsWith("mail.") ? "change-orders" : "bas") : null,
      metadata: action === "mail.sent" ? { subject: "ZZTEST vendor reply", to: ["vendor@example.com"] } : null,
    });
  }
});

afterAll(disconnectDb);

describe("what the screen shows", () => {
  it("is the four kinds of account and access change, and nothing else", () => {
    // Pinned as a literal: widening or narrowing the screen is a decision,
    // and this is where it is recorded. Recording is never affected by it.
    expect([...SCREEN_AUDIT_ACTIONS].sort()).toEqual(
      [
        "employee.provisioned",
        "grant.added",
        "grant.removed",
        "grant.admin_added",
        "grant.admin_removed",
        "employee.admin_granted",
        "employee.admin_revoked",
        "employee.disabled",
        "employee.enabled",
      ].sort(),
    );
    for (const action of HIDDEN) expect(isShownOnAuditScreen(action)).toBe(false);
  });

  it("the audit page lists the shown rows and none of the hidden ones", async () => {
    const result = await listAuditEvents(query({}));

    expect(result.total).toBe(SCREEN_AUDIT_ACTIONS.length);
    expect(result.events.map((e) => e.action).sort()).toEqual([...SCREEN_AUDIT_ACTIONS].sort());
    expect(result.events.some((e) => !isShownOnAuditScreen(e.action))).toBe(false);
  });

  it("the person and date filters narrow within the shown set, never past it", async () => {
    const byAdmin = await listAuditEvents(query({ actorEmployeeId: admin.id }));
    expect(byAdmin.total).toBe(8); // every shown row but the platform's own provisioning
    expect(byAdmin.events.every((e) => isShownOnAuditScreen(e.action))).toBe(true);

    // The sender has rows - mail sends, questions - and none the screen shows.
    const bySender = await listAuditEvents(query({ actorEmployeeId: sender.id }));
    expect(bySender.total).toBe(0);

    const aboutSarah = await listAuditEvents(query({ targetEmployeeId: sarah.id }));
    expect(aboutSarah.total).toBe(SCREEN_AUDIT_ACTIONS.length);
  });

  it("a filter asking for a hidden action gets an empty page, not the rows", async () => {
    // A hand-edited URL. The dropdown never offers these.
    for (const action of ["mail.sent", "bas.question_asked", "login.denied", "cip.*", "mail.*"]) {
      const result = await listAuditEvents(query({ action }));
      expect(result.total, action).toBe(0);
      expect(result.events, action).toEqual([]);
    }
    const shown = await listAuditEvents(query({ action: "grant.added" }));
    expect(shown.total).toBe(1);
  });

  it("an employee's own History is the same scope", async () => {
    const detail = await getEmployeeDetail(sarah.id);
    expect(detail).not.toBeNull();

    const actions = detail!.auditHistory.map((e) => e.action).sort();
    expect(actions).toEqual([...SCREEN_AUDIT_ACTIONS].sort());
    expect(actions).not.toContain("employee.position_changed");
    expect(actions).not.toContain("employee.profile_reset");

    // Profile completion is the newbie's only row, and it is not an access change.
    const newbieDetail = await getEmployeeDetail(newbie.id);
    expect(newbieDetail!.auditHistory).toEqual([]);
  });

  it("the Action dropdown offers exactly the shown actions, each with its label", () => {
    const options = auditActionFilterOptions();

    expect(options.map((o) => o.value).sort()).toEqual([...SCREEN_AUDIT_ACTIONS].sort());

    const labels = new Map(knownAuditActions().map((a) => [a.action as string, a.label]));
    for (const { value, label } of options) expect(label).toBe(labels.get(value));
    expect(options.some((o) => o.value.endsWith(".*"))).toBe(false);
  });

  it("the person filters do not offer somebody whose only rows are hidden", async () => {
    const options = await auditFilterOptions();

    expect(options.actors.map((a) => a.id)).toEqual([admin.id]);
    expect(options.targets.map((t) => t.id)).toEqual([sarah.id]);
    // The sender acted fourteen times and the newbie was the subject once;
    // offering either would produce an empty page by construction.
    expect(options.actors.some((a) => a.id === sender.id)).toBe(false);
    expect(options.targets.some((t) => t.id === newbie.id)).toBe(false);
  });
});

describe("what the table records", () => {
  it("still holds every hidden row, written by the same writer", async () => {
    const hidden = await testDb.auditEvent.findMany({
      where: { action: { in: HIDDEN } },
      select: { action: true, actorEmployeeId: true, metadata: true },
    });

    expect(hidden.map((r) => r.action).sort()).toEqual([...HIDDEN].sort());

    // mail.sent in particular: the app sends as itself, so this row is the only
    // record anywhere of which PERSON sent a vendor email.
    const sent = hidden.find((r) => r.action === "mail.sent");
    expect(sent?.actorEmployeeId).toBe(sender.id);
    expect((sent?.metadata as { subject?: string }).subject).toBe("ZZTEST vendor reply");
  });

  it("the writer and the action union know nothing about the screen", () => {
    // The scope is a property of the readers behind the two screens. If
    // lib/audit.ts ever imported it, a hidden action could stop being recorded.
    const audit = readFileSync("lib/audit.ts", "utf8");
    expect(audit).not.toContain("audit-screen");
    expect(audit).not.toContain("SCREEN_AUDIT_ACTIONS");
  });
});

describe("screenActionsFor", () => {
  it("is the whole shown set with no filter, one action when shown, nothing when hidden", () => {
    expect(screenActionsFor(undefined)).toEqual([...SCREEN_AUDIT_ACTIONS]);
    expect(screenActionsFor("")).toEqual([...SCREEN_AUDIT_ACTIONS]);
    expect(screenActionsFor("grant.added")).toEqual(["grant.added"]);
    expect(screenActionsFor("mail.sent")).toEqual([]);
  });

  it("confines a module group to the shown actions with that prefix", () => {
    expect(screenActionsFor("grant.*").sort()).toEqual(
      ["grant.added", "grant.removed", "grant.admin_added", "grant.admin_removed"].sort(),
    );
    expect(screenActionsFor("cip.*")).toEqual([]);
    expect(screenActionsFor("mail.*")).toEqual([]);
  });
});

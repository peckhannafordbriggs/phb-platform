import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  parseBootstrapAdmins,
  seedBootstrapAdmins,
} from "@/lib/bootstrap-admins";
import { createEmployee, disconnectDb, resetDb, testDb } from "./db";

/**
 * The bootstrap admin list.
 *
 * The seeding half runs against the real database, because the properties that
 * matter - idempotent, never resets anyone, never re-promotes a deliberate
 * demotion - are properties of what the rows look like afterwards.
 */

const FOUR = [
  "msheth@phb1899.com",
  "jschwarz@phb1899.com",
  "jschriner@phb1899.com",
  "bbolten@phb1899.com",
];

async function adminEmails(): Promise<string[]> {
  const rows = await testDb.employee.findMany({
    where: { isPlatformAdmin: true },
    select: { email: true },
    orderBy: { email: "asc" },
  });
  return rows.map((r) => r.email);
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await disconnectDb();
});

describe("parsing the list", () => {
  it("splits on commas and lowercases, like ALLOWED_EMAIL_DOMAINS", () => {
    expect(
      parseBootstrapAdmins("A@phb1899.com, B@phb1899.com ,c@PHB1899.com"),
    ).toEqual({
      emails: ["a@phb1899.com", "b@phb1899.com", "c@phb1899.com"],
      invalid: [],
    });
  });

  it("accepts a single address, the previous format", () => {
    expect(parseBootstrapAdmins("msheth@phb1899.com").emails).toEqual([
      "msheth@phb1899.com",
    ]);
  });

  it("treats absent, empty and whitespace as no admins rather than an error", () => {
    for (const raw of [undefined, null, "", "   ", " , , "]) {
      expect(parseBootstrapAdmins(raw)).toEqual({ emails: [], invalid: [] });
    }
  });

  it("de-duplicates, including across casing", () => {
    const parsed = parseBootstrapAdmins(
      "a@phb1899.com,A@phb1899.com,b@phb1899.com,a@phb1899.com",
    );
    expect(parsed.emails).toEqual(["a@phb1899.com", "b@phb1899.com"]);
  });

  it("reports entries that are not email addresses instead of seeding them", () => {
    const parsed = parseBootstrapAdmins("good@phb1899.com,not-an-email,also bad");
    expect(parsed.emails).toEqual(["good@phb1899.com"]);
    expect(parsed.invalid).toEqual(["not-an-email", "also bad"]);
  });
});

describe("seeding the list", () => {
  it("creates a row per address, ready for first sign-in", async () => {
    const result = await seedBootstrapAdmins(testDb, FOUR);

    expect(result.created.sort()).toEqual([...FOUR].sort());
    expect(await adminEmails()).toEqual([...FOUR].sort());

    for (const email of FOUR) {
      const row = await testDb.employee.findUniqueOrThrow({ where: { email } });
      // Their first sign-in stamps entraOid onto this row rather than making a
      // second one, and they complete onboarding like anyone else.
      expect(row.entraOid).toBeNull();
      expect(row.isPlatformAdmin).toBe(true);
      expect(row.profileCompleted).toBe(false);
      expect(row.status).toBe("active");
    }
  });

  it("writes an audit row for each employee it creates", async () => {
    await seedBootstrapAdmins(testDb, FOUR);

    const provisioned = await testDb.auditEvent.count({
      where: { action: "employee.provisioned" },
    });
    const granted = await testDb.auditEvent.count({
      where: { action: "employee.admin_granted" },
    });

    expect(provisioned).toBe(4);
    expect(granted).toBe(4);
  });

  it("is idempotent - re-running duplicates nobody and writes no new audit rows", async () => {
    await seedBootstrapAdmins(testDb, FOUR);
    const second = await seedBootstrapAdmins(testDb, FOUR);

    expect(second.created).toEqual([]);
    expect(second.promoted).toEqual([]);
    expect(second.unchanged.sort()).toEqual([...FOUR].sort());

    expect(await testDb.employee.count()).toBe(4);
    expect(await testDb.auditEvent.count()).toBe(8);
  });

  it("does not reset a profile someone has already completed", async () => {
    await seedBootstrapAdmins(testDb, FOUR);

    // Simulates the first sign-in and onboarding.
    await testDb.employee.update({
      where: { email: "msheth@phb1899.com" },
      data: {
        entraOid: "oid-real",
        firstName: "Real",
        lastName: "Name",
        profileCompleted: true,
      },
    });

    await seedBootstrapAdmins(testDb, FOUR);

    const row = await testDb.employee.findUniqueOrThrow({
      where: { email: "msheth@phb1899.com" },
    });
    expect(row.entraOid).toBe("oid-real");
    expect(row.firstName).toBe("Real");
    expect(row.profileCompleted).toBe(true);
  });

  it("does NOT flip an admin back after a demotion in the UI", async () => {
    await seedBootstrapAdmins(testDb, FOUR);

    // An admin demotes one of them through the admin screen.
    await testDb.employee.update({
      where: { email: "bbolten@phb1899.com" },
      data: { isPlatformAdmin: false },
    });

    const result = await seedBootstrapAdmins(testDb, FOUR);

    // The demotion was a decision. A deploy must not undo it.
    expect(result.promoted).toEqual([]);
    expect(
      (await testDb.employee.findUniqueOrThrow({
        where: { email: "bbolten@phb1899.com" },
      })).isPlatformAdmin,
    ).toBe(false);
  });

  it("does not touch a bootstrap address that was disabled", async () => {
    await seedBootstrapAdmins(testDb, FOUR);
    await testDb.employee.update({
      where: { email: "jschwarz@phb1899.com" },
      data: { status: "disabled" },
    });

    await seedBootstrapAdmins(testDb, FOUR);

    const row = await testDb.employee.findUniqueOrThrow({
      where: { email: "jschwarz@phb1899.com" },
    });
    expect(row.status).toBe("disabled");
  });

  it("promotes again only when no active admin remains anywhere", async () => {
    await seedBootstrapAdmins(testDb, FOUR);

    // The documented lockout: every admin has lost the flag.
    await testDb.employee.updateMany({ data: { isPlatformAdmin: false } });

    const result = await seedBootstrapAdmins(testDb, FOUR);

    expect(result.promoted.sort()).toEqual([...FOUR].sort());
    expect(await adminEmails()).toEqual([...FOUR].sort());
  });

  it("counts only ACTIVE admins when deciding a lockout", async () => {
    await seedBootstrapAdmins(testDb, FOUR);

    // One admin remains, but disabled - so the platform is still locked out.
    await testDb.employee.updateMany({ data: { isPlatformAdmin: false } });
    await testDb.employee.update({
      where: { email: "msheth@phb1899.com" },
      data: { isPlatformAdmin: true, status: "disabled" },
    });

    const result = await seedBootstrapAdmins(testDb, FOUR);

    expect(result.promoted).toContain("jschwarz@phb1899.com");
    // The disabled one is not re-enabled: that is a decision for a person.
    expect(
      (await testDb.employee.findUniqueOrThrow({
        where: { email: "msheth@phb1899.com" },
      })).status,
    ).toBe("disabled");
  });

  it("leaves a non-bootstrap admin alone and does not count as locked out", async () => {
    const other = await createEmployee({
      entraOid: "oid-unrelated-admin",
      email: "unrelated@phb1899.com",
      isPlatformAdmin: true,
    });

    // An admin already exists, so this is not a lockout. Rows are still created
    // for the list, because they do not exist yet.
    const result = await seedBootstrapAdmins(testDb, FOUR);

    expect(result.created.sort()).toEqual([...FOUR].sort());
    expect(
      (await testDb.employee.findUniqueOrThrow({ where: { id: other.id } }))
        .isPlatformAdmin,
    ).toBe(true);
  });

  it("does nothing at all when the list is empty", async () => {
    const result = await seedBootstrapAdmins(testDb, []);

    expect(result).toEqual({ created: [], promoted: [], unchanged: [] });
    expect(await testDb.employee.count()).toBe(0);
  });
});

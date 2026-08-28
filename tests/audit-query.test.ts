import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listAuditEvents, auditFilterOptions } from "@/lib/admin/service";
import { auditQuerySchema } from "@/lib/validation/admin";
import {
  createEmployee,
  disconnectDb,
  resetDb,
  seedChangeOrdersModule,
  testDb,
} from "./db";

/**
 * Reading the audit log: filtering, date ranges, ordering and paging.
 *
 * The renderer is tested separately in audit-describe.test.ts. This file is
 * about the query - and specifically about the date range, which is the one
 * filter PHASE-10 adds and the one with a boundary that is easy to get wrong by
 * a day in either direction.
 */

const AT = (iso: string) => new Date(iso);

async function writeEvent(
  action: string,
  actorId: string | null,
  targetId: string | null,
  occurredAt: Date,
): Promise<void> {
  // occurredAt has a database default, so it is set explicitly here rather than
  // through writeAuditEvent - these tests need events at chosen instants.
  await testDb.auditEvent.create({
    data: {
      action,
      actorEmployeeId: actorId,
      targetEmployeeId: targetId,
      occurredAt,
    },
  });
}

let admin: { id: string };
let sarah: { id: string };
let other: { id: string };

beforeEach(async () => {
  await resetDb();
  await seedChangeOrdersModule();

  admin = await createEmployee({
    email: "admin@phb1899.com",
    firstName: "Jim",
    lastName: "Schwarz",
    isPlatformAdmin: true,
  });
  sarah = await createEmployee({
    email: "sarah@phb1899.com",
    firstName: "Sarah",
    lastName: "Martin",
  });
  other = await createEmployee({
    email: "other@phb1899.com",
    firstName: "Pat",
    lastName: "Nolan",
  });

  await writeEvent("grant.added", admin.id, sarah.id, AT("2026-09-10T09:00:00Z"));
  await writeEvent("grant.removed", admin.id, sarah.id, AT("2026-09-12T09:00:00Z"));
  // Late on the 12th - the row a naive `lte midnight` bound would drop.
  await writeEvent("employee.disabled", admin.id, other.id, AT("2026-09-12T23:59:00Z"));
  await writeEvent("employee.enabled", admin.id, other.id, AT("2026-09-14T09:00:00Z"));
  await writeEvent("employee.provisioned", null, sarah.id, AT("2026-09-01T09:00:00Z"));
});

afterAll(disconnectDb);

const query = (raw: Record<string, string>) => auditQuerySchema.parse(raw);

describe("filtering by who", () => {
  it("filters by target", async () => {
    const result = await listAuditEvents(query({ targetEmployeeId: sarah.id }));

    expect(result.total).toBe(3);
    expect(result.events.every((e) => e.target?.id === sarah.id)).toBe(true);
  });

  it("filters by actor, and excludes rows the platform wrote", async () => {
    const result = await listAuditEvents(query({ actorEmployeeId: admin.id }));

    // employee.provisioned has a null actor: the platform acted, not a person.
    expect(result.total).toBe(4);
    expect(result.events.some((e) => e.action === "employee.provisioned")).toBe(false);
  });

  it("filters by action", async () => {
    const result = await listAuditEvents(query({ action: "grant.added" }));

    expect(result.total).toBe(1);
    expect(result.events[0]?.action).toBe("grant.added");
  });

  it("combines filters", async () => {
    const result = await listAuditEvents(
      query({ targetEmployeeId: sarah.id, action: "grant.removed" }),
    );

    expect(result.total).toBe(1);
  });
});

describe("filtering by date", () => {
  it("includes everything on the `to` day, not just its first instant", async () => {
    /**
     * The boundary this filter exists to get right.
     *
     * `to=2026-09-12` means "up to the end of the 12th" to whoever typed it.
     * Comparing `lte` against midnight would return the 09:00 row and silently
     * drop the 23:59 one - a filter that loses most of a day while looking like
     * it worked.
     */
    const result = await listAuditEvents(query({ to: "2026-09-12" }));

    const days = result.events.map((e) => e.occurredAt.toISOString().slice(0, 10));
    expect(days).toContain("2026-09-12");
    expect(result.events.filter((e) => e.occurredAt.getUTCHours() === 23)).toHaveLength(1);
    expect(result.total).toBe(4);
  });

  it("excludes the day after the `to` bound", async () => {
    const result = await listAuditEvents(query({ to: "2026-09-12" }));

    expect(result.events.some((e) => e.action === "employee.enabled")).toBe(false);
  });

  it("includes the `from` day from its first instant", async () => {
    const result = await listAuditEvents(query({ from: "2026-09-12" }));

    expect(result.total).toBe(3);
    expect(result.events.some((e) => e.action === "grant.added")).toBe(false);
  });

  it("bounds both ends", async () => {
    const result = await listAuditEvents(
      query({ from: "2026-09-10", to: "2026-09-12" }),
    );

    expect(result.total).toBe(3);
    expect(result.events.some((e) => e.action === "employee.provisioned")).toBe(false);
    expect(result.events.some((e) => e.action === "employee.enabled")).toBe(false);
  });

  it("a single day returns only that day", async () => {
    const result = await listAuditEvents(
      query({ from: "2026-09-12", to: "2026-09-12" }),
    );

    expect(result.total).toBe(2);
  });

  it("honours a full timestamp as given, rather than rounding it up a day", async () => {
    // A bare date means the whole day; an explicit instant means that instant.
    const result = await listAuditEvents(
      query({ to: "2026-09-12T12:00:00.000Z" }),
    );

    expect(result.total).toBe(3);
    expect(result.events.some((e) => e.occurredAt.getUTCHours() === 23)).toBe(false);
  });

  it("reads a bare date as UTC, matching how occurredAt is stored", async () => {
    const parsed = auditQuerySchema.parse({ from: "2026-09-12" });

    // Reading it as local time would shift the boundary by the machine's offset
    // and change which events a filter returns depending on where it runs.
    expect(parsed.from?.toISOString()).toBe("2026-09-12T00:00:00.000Z");
  });
});

describe("rejecting a filter that cannot mean anything", () => {
  it("refuses a range that runs backwards", () => {
    const parsed = auditQuerySchema.safeParse({ from: "2026-09-14", to: "2026-09-10" });

    expect(parsed.success).toBe(false);
  });

  it("refuses a date that is not a date", () => {
    expect(auditQuerySchema.safeParse({ from: "last tuesday" }).success).toBe(false);
  });

  it("accepts an equal from and to", () => {
    expect(
      auditQuerySchema.safeParse({ from: "2026-09-12", to: "2026-09-12" }).success,
    ).toBe(true);
  });
});

describe("ordering and paging", () => {
  it("returns newest first", async () => {
    const result = await listAuditEvents(query({}));
    const times = result.events.map((e) => e.occurredAt.getTime());

    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("is stable across identical requests when timestamps collide", async () => {
    // Two events written in one transaction share a timestamp. A log that
    // reorders itself between two identical requests is not a log.
    const shared = AT("2026-09-20T12:00:00Z");
    await writeEvent("grant.added", admin.id, sarah.id, shared);
    await writeEvent("grant.removed", admin.id, sarah.id, shared);
    await writeEvent("grant.added", admin.id, other.id, shared);

    const first = await listAuditEvents(query({}));
    const second = await listAuditEvents(query({}));

    expect(second.events.map((e) => e.id)).toEqual(first.events.map((e) => e.id));
  });

  it("pages without repeating or dropping a row", async () => {
    const all = await listAuditEvents(query({ pageSize: "50" }));
    const seen: string[] = [];

    for (let page = 1; page <= Math.ceil(all.total / 2); page += 1) {
      const result = await listAuditEvents(query({ page: String(page), pageSize: "2" }));
      seen.push(...result.events.map((e) => e.id));
    }

    expect(seen).toHaveLength(all.total);
    expect(new Set(seen).size).toBe(all.total);
  });

  it("reports totalPages against the filtered total, not the whole table", async () => {
    const result = await listAuditEvents(
      query({ action: "grant.added", pageSize: "1" }),
    );

    expect(result.total).toBe(1);
    expect(result.totalPages).toBe(1);
  });
});

describe("the rows carry what the renderer needs", () => {
  it("selects names, not just ids and emails", async () => {
    const result = await listAuditEvents(query({ action: "grant.added" }));
    const row = result.events[0];

    // The whole complaint Phase 10 fixes: an id is not an answer.
    expect(row?.actor?.firstName).toBe("Jim");
    expect(row?.actor?.lastName).toBe("Schwarz");
    expect(row?.target?.firstName).toBe("Sarah");
  });

  it("keeps a null actor null rather than inventing one", async () => {
    const result = await listAuditEvents(query({ action: "employee.provisioned" }));

    expect(result.events[0]?.actor).toBeNull();
  });
});

describe("the filter dropdown options", () => {
  it("offers only people who actually appear in the log", async () => {
    const unrelated = await createEmployee({ email: "nobody@phb1899.com" });
    const options = await auditFilterOptions();

    expect(options.actors.map((a) => a.id)).toEqual([admin.id]);
    expect(options.targets.map((t) => t.id).sort()).toEqual(
      [sarah.id, other.id].sort(),
    );
    // Somebody with no audit rows would only ever produce an empty page.
    expect(options.targets.some((t) => t.id === unrelated.id)).toBe(false);
  });

  it("does not offer the platform as an actor", async () => {
    const options = await auditFilterOptions();

    // The provisioned row has a null actor; there is no id to filter by.
    expect(options.actors).toHaveLength(1);
  });
});

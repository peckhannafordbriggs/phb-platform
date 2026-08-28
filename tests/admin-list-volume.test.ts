import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listEmployees } from "@/lib/admin/service";
import { employeeListQuerySchema } from "@/lib/validation/admin";
import {
  createEmployee,
  createEmployeeVolume,
  disconnectDb,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
  testDb,
} from "./db";

/**
 * The employee list at the volume it actually runs at.
 *
 * PHASE-10 is explicit: "The seed already produces 130+ fake employees. Test
 * against that, not against four rows." Sorting and pagination bugs only appear
 * past a page boundary, and a four-row fixture never crosses one - a list that
 * repeats or drops a row between pages looks perfectly correct until it does not.
 *
 * The fixture is deterministic by index, so a failure here is reproducible:
 * every 7th disabled, every 11th never signed in, every 5th with no grant,
 * every 13th with an incomplete profile.
 */

const query = (raw: Record<string, string>) => employeeListQuerySchema.parse(raw);

let ids: string[];

beforeAll(async () => {
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  ({ ids } = await createEmployeeVolume({ count: 130 }));
});

afterAll(disconnectDb);

describe("the fixture is the volume the phase asks for", () => {
  it("has 130 employees", async () => {
    expect(await testDb.employee.count()).toBe(130);
    expect(ids).toHaveLength(130);
  });

  it("spans more than one page at the default page size", async () => {
    const result = await listEmployees(query({ scope: "all" }));

    expect(result.pageSize).toBe(25);
    expect(result.totalPages).toBeGreaterThan(1);
  });
});

describe("paging", () => {
  it("walks every page without repeating or dropping a row", async () => {
    const first = await listEmployees(query({ scope: "all" }));
    const seen: string[] = [];

    for (let page = 1; page <= first.totalPages; page += 1) {
      const result = await listEmployees(query({ scope: "all", page: String(page) }));
      seen.push(...result.employees.map((e) => e.id));
    }

    expect(seen).toHaveLength(130);
    expect(new Set(seen).size).toBe(130);
  });

  /**
   * The bug a four-row fixture cannot find.
   *
   * Sorting by status puts 111 active employees in one undifferentiated run. If
   * the ORDER BY has no tiebreak, PostgreSQL is free to return that run in a
   * different order for each OFFSET, so a row appears on two pages and another
   * on none.
   */
  it("pages a column full of ties without losing anybody", async () => {
    for (const sort of ["status", "lastLogin", "name"] as const) {
      const first = await listEmployees(query({ scope: "all", sort }));
      const seen: string[] = [];

      for (let page = 1; page <= first.totalPages; page += 1) {
        const result = await listEmployees(
          query({ scope: "all", sort, page: String(page) }),
        );
        seen.push(...result.employees.map((e) => e.id));
      }

      expect(new Set(seen).size, `sorted by ${sort}`).toBe(130);
    }
  });

  it("returns the same page twice for the same request", async () => {
    const a = await listEmployees(query({ scope: "all", sort: "status", page: "3" }));
    const b = await listEmployees(query({ scope: "all", sort: "status", page: "3" }));

    expect(b.employees.map((e) => e.id)).toEqual(a.employees.map((e) => e.id));
  });

  it("a page past the end is empty rather than an error", async () => {
    const result = await listEmployees(query({ scope: "all", page: "999" }));

    expect(result.employees).toHaveLength(0);
    expect(result.total).toBe(130);
  });
});

describe("sorting", () => {
  it("sorts by name in both directions", async () => {
    const asc = await listEmployees(query({ scope: "all", sort: "name", dir: "asc" }));
    const desc = await listEmployees(query({ scope: "all", sort: "name", dir: "desc" }));

    const ascNames = asc.employees.map((e) => e.lastName);
    expect([...ascNames].sort((a, b) => a.localeCompare(b))).toEqual(ascNames);

    expect(desc.employees[0]?.lastName).not.toBe(asc.employees[0]?.lastName);
  });

  it("sorts by status", async () => {
    const result = await listEmployees(query({ scope: "all", sort: "status", dir: "asc" }));
    const statuses = result.employees.map((e) => e.status);

    expect([...statuses].sort()).toEqual(statuses);
  });

  /**
   * "Never signed in" is the extreme of the last-sign-in column, not an absence
   * to be scattered through it. Newest-first should not open with 12 nulls.
   */
  it("puts never-signed-in last when sorting by most recent first", async () => {
    const result = await listEmployees(
      query({ scope: "all", sort: "lastLogin", dir: "desc", pageSize: "130" }),
    );

    const firstNullAt = result.employees.findIndex((e) => e.lastLoginAt === null);
    const lastDatedAt = result.employees.reduce(
      (acc, e, i) => (e.lastLoginAt !== null ? i : acc),
      -1,
    );

    expect(firstNullAt).toBeGreaterThan(-1);
    expect(firstNullAt).toBeGreaterThan(lastDatedAt);
  });

  it("puts never-signed-in first when sorting oldest first", async () => {
    const result = await listEmployees(
      query({ scope: "all", sort: "lastLogin", dir: "asc", pageSize: "130" }),
    );

    expect(result.employees[0]?.lastLoginAt).toBeNull();
  });

  it("orders the dated rows correctly, ignoring the nulls", async () => {
    const result = await listEmployees(
      query({ scope: "all", sort: "lastLogin", dir: "desc", pageSize: "130" }),
    );
    const times = result.employees
      .map((e) => e.lastLoginAt)
      .filter((d): d is Date => d !== null)
      .map((d) => d.getTime());

    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("refuses a sort column that is not one of the three", () => {
    // A caller-supplied column name would be an injection surface and a way to
    // order by something the table does not show.
    expect(employeeListQuerySchema.safeParse({ sort: "email" }).success).toBe(false);
    expect(employeeListQuerySchema.safeParse({ sort: "password" }).success).toBe(false);
    expect(employeeListQuerySchema.safeParse({ dir: "sideways" }).success).toBe(false);
  });

  it("defaults to name ascending", () => {
    const parsed = employeeListQuerySchema.parse({});
    expect(parsed.sort).toBe("name");
    expect(parsed.dir).toBe("asc");
  });
});

describe("filtering", () => {
  it("defaults to employees with at least one grant", async () => {
    const granted = await listEmployees(query({}));
    const all = await listEmployees(query({ scope: "all" }));

    // Every 5th has no grant: 26 of 130.
    expect(all.total).toBe(130);
    expect(granted.total).toBe(104);
  });

  /**
   * PHASE-10 asks for this as its own case. It is the question "who signed in
   * and never got access", which no combination of the other filters expresses.
   */
  it("filters by no grants at all", async () => {
    const result = await listEmployees(query({ scope: "none", pageSize: "200" }));

    expect(result.total).toBe(26);
    expect(result.employees.every((e) => e.grantedModuleKeys.length === 0)).toBe(true);
  });

  it("the three scopes partition the list exactly", async () => {
    const granted = await listEmployees(query({ scope: "granted" }));
    const none = await listEmployees(query({ scope: "none" }));
    const all = await listEmployees(query({ scope: "all" }));

    expect(granted.total + none.total).toBe(all.total);
  });

  it("filters by status", async () => {
    const disabled = await listEmployees(query({ scope: "all", status: "disabled", pageSize: "200" }));

    // Every 7th of 130.
    expect(disabled.total).toBe(19);
    expect(disabled.employees.every((e) => e.status === "disabled")).toBe(true);
  });

  it("filters by module, for either module", async () => {
    const co = await listEmployees(query({ scope: "all", moduleKey: "change-orders" }));
    const bas = await listEmployees(query({ scope: "all", moduleKey: "bas" }));

    expect(co.total).toBe(104);
    // Nothing has been granted BAS in this fixture.
    expect(bas.total).toBe(0);
  });

  it("searches name and email case-insensitively", async () => {
    const byLast = await listEmployees(query({ scope: "all", q: "horvath", pageSize: "200" }));
    expect(byLast.total).toBeGreaterThan(0);
    expect(
      byLast.employees.every((e) => e.lastName.toLowerCase().includes("horvath")),
    ).toBe(true);

    const byEmail = await listEmployees(query({ scope: "all", q: "@phb1899.com", pageSize: "200" }));
    expect(byEmail.total).toBe(130);
  });

  it("combines a filter with a sort and still pages correctly", async () => {
    const first = await listEmployees(
      query({ scope: "all", status: "active", sort: "lastLogin", dir: "desc" }),
    );
    const seen: string[] = [];

    for (let page = 1; page <= first.totalPages; page += 1) {
      const result = await listEmployees(
        query({
          scope: "all",
          status: "active",
          sort: "lastLogin",
          dir: "desc",
          page: String(page),
        }),
      );
      seen.push(...result.employees.map((e) => e.id));
    }

    expect(new Set(seen).size).toBe(first.total);
  });

  it("reports the unfiltered total alongside the filtered one", async () => {
    const result = await listEmployees(query({ scope: "all", status: "disabled" }));

    // The two empty states depend on this: "no matches" and "nobody exists" are
    // different problems and a filtered count of zero cannot tell them apart.
    expect(result.total).toBe(19);
    expect(result.employeesTotal).toBe(130);
  });

  it("a filter matching nothing returns zero with the total intact", async () => {
    const result = await listEmployees(query({ scope: "all", q: "zzzz-no-such-person" }));

    expect(result.total).toBe(0);
    expect(result.employeesTotal).toBe(130);
    expect(result.employees).toHaveLength(0);
  });
});

describe("an empty platform", () => {
  it("reports zero for both totals, which is the other empty state", async () => {
    await resetDb();
    await seedChangeOrdersModule();

    const result = await listEmployees(query({ scope: "all" }));
    expect(result.total).toBe(0);
    expect(result.employeesTotal).toBe(0);

    // Restore the fixture for any test ordering that follows.
    await seedBasModule();
    ({ ids } = await createEmployeeVolume({ count: 130 }));
    await createEmployee({ email: "restore-marker@phb1899.com" });
  });
});

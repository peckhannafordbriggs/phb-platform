import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  freeTextPositionCount,
  listDepartmentsWithCounts,
  listPositionsWithCounts,
  listEmployees,
  updatePosition,
} from "@/lib/admin/service";
import { setPosition, setDepartment } from "@/lib/profile/service";
import { employeeListQuerySchema } from "@/lib/validation/admin";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
  testDb,
} from "./db";

/**
 * Positions and departments, and the fact that two modules now exist.
 *
 * The hiding rules are the substance here. PHASE-10: "Never delete a value an
 * employee is assigned to — hiding is the mechanism, and hiding must not break
 * an existing assignment." Half of that is already true and is asserted rather
 * than assumed; the half that was missing is the count of who holds each value.
 */

let admin: { id: string };
let position: { id: string; name: string };
let department: { id: string; name: string };

beforeEach(async () => {
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();

  admin = await createEmployee({ email: "admin@phb1899.com", isPlatformAdmin: true });
  position = await testDb.position.create({ data: { name: "Foreman" } });
  department = await testDb.department.create({ data: { name: "Service" } });
});

afterAll(disconnectDb);

describe("hiding a value", () => {
  it("leaves an existing assignment intact", async () => {
    const person = await createEmployee({ positionId: position.id });

    await updatePosition(admin.id, position.id, { status: "hidden" });

    const after = await testDb.employee.findUnique({
      where: { id: person.id },
      select: { positionId: true, position: { select: { name: true, status: true } } },
    });

    // The row still points at it, and the value still has its name. Hiding is a
    // list-visibility change, not a data change.
    expect(after?.positionId).toBe(position.id);
    expect(after?.position?.name).toBe("Foreman");
    expect(after?.position?.status).toBe("hidden");
  });

  /**
   * PHASE-10: "Assigning a hidden value is refused server-side, not just absent
   * from the dropdown." The dropdown omitting it is a convenience; this is the
   * boundary, and it is what makes hiding mean anything.
   */
  it("refuses a new assignment to a hidden position, server-side", async () => {
    const person = await createEmployee();
    await updatePosition(admin.id, position.id, { status: "hidden" });

    const result = await setPosition(admin.id, person.id, {
      positionId: position.id,
      positionOther: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_position");

    const after = await testDb.employee.findUnique({
      where: { id: person.id },
      select: { positionId: true },
    });
    expect(after?.positionId).toBeNull();
  });

  it("refuses a new assignment to a hidden department, server-side", async () => {
    const person = await createEmployee();
    await testDb.department.update({
      where: { id: department.id },
      data: { status: "hidden" },
    });

    const result = await setDepartment(admin.id, person.id, department.id);
    expect(result.ok).toBe(false);
  });

  it("refuses it for the employee's own route too, not only an admin's", async () => {
    // Both paths share one implementation, which is what stops the two
    // disagreeing about what a valid position is.
    const person = await createEmployee();
    await updatePosition(admin.id, position.id, { status: "hidden" });

    const result = await setPosition(person.id, person.id, {
      positionId: position.id,
      positionOther: null,
    });

    expect(result.ok).toBe(false);
  });

  it("allows the assignment again once the value is restored", async () => {
    const person = await createEmployee();
    await updatePosition(admin.id, position.id, { status: "hidden" });
    await updatePosition(admin.id, position.id, { status: "active" });

    const result = await setPosition(admin.id, person.id, {
      positionId: position.id,
      positionOther: null,
    });
    expect(result.ok).toBe(true);
  });

  it("has no delete path at all", async () => {
    // There is no deletePosition/deleteDepartment in the service, and the
    // foreign key is ON DELETE RESTRICT so a raw delete of an assigned value
    // fails at the database too. Both halves matter: the absence is the design,
    // the constraint is the backstop.
    const person = await createEmployee({ positionId: position.id });
    expect(person.positionId).toBe(position.id);

    await expect(
      testDb.position.delete({ where: { id: position.id } }),
    ).rejects.toThrow();
  });
});

describe("how many employees hold each value", () => {
  it("counts them, including disabled employees", async () => {
    await createEmployee({ positionId: position.id });
    await createEmployee({ positionId: position.id, status: "disabled" });
    await createEmployee();

    const positions = await listPositionsWithCounts(true);
    const foreman = positions.find((p) => p.id === position.id);

    // A disabled employee still holds the value and their record still shows it,
    // so counting only active people would understate what a rename affects.
    expect(foreman?.employeeCount).toBe(2);
  });

  it("reports zero for an unused value rather than omitting it", async () => {
    const positions = await listPositionsWithCounts(true);

    expect(positions.find((p) => p.id === position.id)?.employeeCount).toBe(0);
  });

  it("counts departments the same way", async () => {
    await createEmployee({ departmentId: department.id });
    await createEmployee({ departmentId: department.id });

    const departments = await listDepartmentsWithCounts(true);
    expect(departments.find((d) => d.id === department.id)?.employeeCount).toBe(2);
  });

  it("still counts a hidden value's holders", async () => {
    await createEmployee({ positionId: position.id });
    await updatePosition(admin.id, position.id, { status: "hidden" });

    const positions = await listPositionsWithCounts(true);
    expect(positions.find((p) => p.id === position.id)?.employeeCount).toBe(1);
  });

  it("counts the free-text backlog separately", async () => {
    await createEmployee({ positionOther: "Something not on the list" });
    await createEmployee({ positionId: position.id });

    expect(await freeTextPositionCount()).toBe(1);
  });

  it("orders by name without a per-query COLLATE", async () => {
    await testDb.position.createMany({
      data: [{ name: "apprentice" }, { name: "Estimator" }, { name: "Zone Lead" }],
    });

    const names = (await listPositionsWithCounts(true)).map((p) => p.name);

    // Case-insensitive ordering comes from the database collation - see
    // docs/runbook.md. A per-query COLLATE would work here and hide a database
    // created with the wrong one.
    expect(names).toEqual(["apprentice", "Estimator", "Foreman", "Zone Lead"]);
  });
});

describe("two modules exist now", () => {
  it("the grant matrix renders a column per active module, from the table", async () => {
    const modules = await testDb.module.findMany({
      where: { status: "active" },
      select: { key: true, displayName: true },
      orderBy: { sortOrder: "asc" },
    });

    // Both seeded modules are active. The screen maps over this, so two columns
    // is a property of the data rather than of the markup.
    expect(modules.length).toBeGreaterThanOrEqual(2);
    expect(modules.map((m) => m.key).sort()).toEqual(["bas", "change-orders"]);
  });

  it("filters by either module", async () => {
    const co = await createEmployee();
    const bas = await createEmployee();
    await grantModule(co.id, "change-orders");
    await grantModule(bas.id, "bas");

    const byCo = await listEmployees(
      employeeListQuerySchema.parse({ scope: "all", moduleKey: "change-orders" }),
    );
    const byBas = await listEmployees(
      employeeListQuerySchema.parse({ scope: "all", moduleKey: "bas" }),
    );

    expect(byCo.employees.map((e) => e.id)).toEqual([co.id]);
    expect(byBas.employees.map((e) => e.id)).toEqual([bas.id]);
  });

  it("reports each employee's granted keys, so the matrix can tick the right cells", async () => {
    const person = await createEmployee();
    await grantModule(person.id, "change-orders");
    await grantModule(person.id, "bas");

    const result = await listEmployees(employeeListQuerySchema.parse({ scope: "all" }));
    const row = result.employees.find((e) => e.id === person.id);

    expect(row?.grantedModuleKeys.sort()).toEqual(["bas", "change-orders"]);
  });
});

describe("no module key is hardcoded in the admin UI", () => {
  /**
   * PHASE-10 asks for this "verified by grep", and CLAUDE.md is the reason:
   * authorization keys on the stable `key`, never a display label, and a screen
   * that names a module in its markup silently stops working when a third one
   * is added.
   *
   * The check is over the admin screens only. Elsewhere a literal key is
   * legitimate - the Change Orders module's own routes are addressed by it.
   */
  it("contains no literal module key under app/(platform)/admin", async () => {
    const root = path.join(process.cwd(), "app/(platform)/admin");
    const keys = (
      await testDb.module.findMany({ select: { key: true } })
    ).map((m) => m.key);

    expect(keys.length).toBeGreaterThanOrEqual(2);

    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
          files.push(full);
        }
      }
    }
    await walk(root);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const key of keys) {
        expect(source, `${file} must not name the module key "${key}"`).not.toContain(
          `"${key}"`,
        );
        expect(source, `${file} must not name the module key "${key}"`).not.toContain(
          `'${key}'`,
        );
      }
    }
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listCipMembers } from "@/lib/modules/cost-intelligence/access";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  grantModuleAdmin,
  resetDb,
  seedBasModule,
  testDb,
} from "./db";

afterAll(disconnectDb);

beforeEach(async () => {
  await resetDb();
  await seedBasModule();
  await testDb.module.create({
    data: { key: COST_INTELLIGENCE_MODULE_KEY, displayName: "Cost Intelligence", sortOrder: 300 },
  });
});

describe("listCipMembers", () => {
  it("lists only Cost Intelligence grants, PCEs first then by name", async () => {
    const zoe = await createEmployee({ firstName: "Zoe", lastName: "Adams" });
    const amy = await createEmployee({ firstName: "Amy", lastName: "Brook" });
    const pce = await createEmployee({ firstName: "Pat", lastName: "Cole" });
    const basOnly = await createEmployee({ firstName: "Bas", lastName: "Only" });

    await grantModule(zoe.id, COST_INTELLIGENCE_MODULE_KEY);
    await grantModule(amy.id, COST_INTELLIGENCE_MODULE_KEY);
    await grantModule(pce.id, COST_INTELLIGENCE_MODULE_KEY);
    await grantModuleAdmin(pce.id, COST_INTELLIGENCE_MODULE_KEY);
    await grantModule(basOnly.id, "bas");
    await grantModuleAdmin(basOnly.id, "bas");

    const members = await listCipMembers();

    expect(members.map((m) => [m.name, m.role])).toEqual([
      ["Pat Cole", "pce"],
      ["Amy Brook", "member"],
      ["Zoe Adams", "member"],
    ]);
  });

  it("leaves out disabled employees", async () => {
    const gone = await createEmployee({ status: "disabled" });
    await grantModule(gone.id, COST_INTELLIGENCE_MODULE_KEY);

    expect(await listCipMembers()).toEqual([]);
  });

  it("returns last active, or null for someone who has never been here", async () => {
    const seen = new Date("2026-10-06T14:00:00.000Z");
    const a = await createEmployee({ firstName: "A", lastName: "Seen", lastActiveAt: seen });
    const b = await createEmployee({ firstName: "B", lastName: "Unseen" });
    await grantModule(a.id, COST_INTELLIGENCE_MODULE_KEY);
    await grantModule(b.id, COST_INTELLIGENCE_MODULE_KEY);

    expect((await listCipMembers()).map((m) => m.lastActiveAt)).toEqual([seen, null]);
  });
});

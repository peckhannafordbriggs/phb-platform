import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard, the routes and the service are real.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import * as projects from "@/app/api/modules/freeze-protection/projects/route";
import * as project from "@/app/api/modules/freeze-protection/projects/[id]/route";
import * as projectBuildings from "@/app/api/modules/freeze-protection/projects/[id]/buildings/route";
import * as projectRounds from "@/app/api/modules/freeze-protection/projects/[id]/verifications/route";
import * as building from "@/app/api/modules/freeze-protection/buildings/[id]/route";
import * as equipmentList from "@/app/api/modules/freeze-protection/equipment/route";
import * as equipment from "@/app/api/modules/freeze-protection/equipment/[id]/route";
import * as round from "@/app/api/modules/freeze-protection/verifications/[id]/route";
import * as signoff from "@/app/api/modules/freeze-protection/verifications/[id]/signoff/route";
import * as result from "@/app/api/modules/freeze-protection/results/[id]/route";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { createEmployee, disconnectDb, grantModule, resetDb, testDb } from "./db";

const authMock = vi.mocked(auth);

async function signIn(grant: boolean) {
  const employee = await createEmployee();
  if (grant) await grantModule(employee.id, FREEZE_PROTECTION_MODULE_KEY);
  authMock.mockResolvedValue({
    entraOid: employee.entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
  return employee;
}

const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const data = async <T>(res: Response) => ((await res.json()) as { data: T }).data;
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

/** Every handler in the module, called once. The access tests walk this list. */
const EVERY_ROUTE: [string, () => Promise<Response>][] = [
  ["GET projects", () => projects.GET()],
  ["POST projects", () => projects.POST(req("POST", { jobNumber: "1", name: "X", buildings: ["A"] }))],
  ["GET project", () => project.GET(req("GET"), ctx("1"))],
  ["PATCH project", () => project.PATCH(req("PATCH", { name: "Y" }), ctx("1"))],
  ["DELETE project", () => project.DELETE(req("DELETE"), ctx("1"))],
  ["POST building", () => projectBuildings.POST(req("POST", { name: "B" }), ctx("1"))],
  ["POST round", () => projectRounds.POST(req("POST", { verificationDate: "2026-10-22" }), ctx("1"))],
  ["PATCH building", () => building.PATCH(req("PATCH", { name: "B" }), ctx("1"))],
  ["DELETE building", () => building.DELETE(req("DELETE"), ctx("1"))],
  ["POST equipment", () => equipmentList.POST(req("POST", { buildingId: "1", tag: "AHU-1" }))],
  ["PATCH equipment", () => equipment.PATCH(req("PATCH", { tag: "AHU-2" }), ctx("1"))],
  ["DELETE equipment", () => equipment.DELETE(req("DELETE"), ctx("1"))],
  ["GET round", () => round.GET(req("GET"), ctx("1"))],
  ["PATCH round", () => round.PATCH(req("PATCH", { transmittedTo: "CM" }), ctx("1"))],
  ["DELETE round", () => round.DELETE(req("DELETE"), ctx("1"))],
  ["POST signoff", () => signoff.POST(req("POST", { role: "completed", signed: true }), ctx("1"))],
  ["PATCH result", () => result.PATCH(req("PATCH", { exposure: "yes" }), ctx("1"))],
];

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetDb();
  await testDb.module.create({
    data: { key: FREEZE_PROTECTION_MODULE_KEY, displayName: "Freeze Protection", sortOrder: 500 },
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(disconnectDb);

describe("access", () => {
  it("401 on every route with no session", async () => {
    authMock.mockResolvedValue(null as never);
    for (const [name, call] of EVERY_ROUTE) expect((await call()).status, name).toBe(401);
  });

  it("404 on every route without the grant, and nothing is written", async () => {
    await signIn(false);
    for (const [name, call] of EVERY_ROUTE) expect((await call()).status, name).toBe(404);
    expect(await testDb.fpProject.count()).toBe(0);
    expect(await testDb.auditEvent.count({ where: { action: { startsWith: "fp." } } })).toBe(0);
  });

  it("a grant alone is enough to do everything (no module-admin actions)", async () => {
    await signIn(true);
    const created = await projects.POST(req("POST", { jobNumber: "26-104A", name: "Riverside", buildings: ["Main"] }));
    expect(created.status).toBe(201);
    const p = await data<{ id: string }>(created);
    expect((await project.DELETE(req("DELETE"), ctx(p.id))).status).toBe(200);
  });
});

describe("validation", () => {
  beforeEach(() => signIn(true));

  it("422 for an unknown field rather than ignoring it", async () => {
    const res = await projects.POST(req("POST", { jobNumber: "1", name: "X", buildings: ["A"], owner: "me" }));
    expect(res.status).toBe(422);
  });

  it("422 for a value outside the vocabulary", async () => {
    expect((await result.PATCH(req("PATCH", { protection: "hope" }), ctx("1"))).status).toBe(422);
    expect((await result.PATCH(req("PATCH", { testFanStops: "y" }), ctx("1"))).status).toBe(422);
  });

  it("422 for a date that is not a real day", async () => {
    expect((await projectRounds.POST(req("POST", { verificationDate: "2026-02-30" }), ctx("1"))).status).toBe(422);
  });

  it("422 for a body that is not JSON", async () => {
    expect((await projects.POST(req("POST", "not json"))).status).toBe(422);
  });

  it("404 for an id that is not a number, not a 500", async () => {
    expect((await project.GET(req("GET"), ctx("abc"))).status).toBe(404);
    expect((await equipment.DELETE(req("DELETE"), ctx("1; drop"))).status).toBe(404);
  });
});

describe("the service's refusals reach the caller as their own codes", () => {
  it("409 job_number_taken", async () => {
    await signIn(true);
    const body = { jobNumber: "26-104A", name: "Riverside", buildings: ["Main"] };
    expect((await projects.POST(req("POST", body))).status).toBe(201);
    const again = await projects.POST(req("POST", body));
    expect(again.status).toBe(409);
    expect(await code(again)).toBe("job_number_taken");
  });

  it("409 self_review, end to end", async () => {
    await signIn(true);
    const p = await data<{ id: string; buildings: { id: string }[] }>(
      await projects.POST(req("POST", { jobNumber: "26-1", name: "X", buildings: ["Main"] })),
    );
    await equipmentList.POST(req("POST", { buildingId: p.buildings[0]!.id, tag: "AHU-1" }));
    const v = await data<{ id: string }>(await projectRounds.POST(req("POST", { verificationDate: "2026-10-22" }), ctx(p.id)));
    expect((await signoff.POST(req("POST", { role: "completed", signed: true }), ctx(v.id))).status).toBe(200);
    const self = await signoff.POST(req("POST", { role: "reviewed", signed: true }), ctx(v.id));
    expect(self.status).toBe(409);
    expect(await code(self)).toBe("self_review");
  });
});

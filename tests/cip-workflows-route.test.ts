import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard and the service are real.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { POST } from "@/app/api/modules/cost-intelligence/workflows/route";
import { DELETE, PATCH } from "@/app/api/modules/cost-intelligence/workflows/[id]/route";
import { PUT } from "@/app/api/modules/cost-intelligence/workflows/[id]/steps/route";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { createEmployee, disconnectDb, grantModule, grantModuleAdmin, resetDb, testDb } from "./db";

const authMock = vi.mocked(auth);

async function signIn({ grant, admin }: { grant: boolean; admin: boolean }) {
  const employee = await createEmployee();
  if (grant) await grantModule(employee.id, COST_INTELLIGENCE_MODULE_KEY);
  if (admin) await grantModuleAdmin(employee.id, COST_INTELLIGENCE_MODULE_KEY);
  authMock.mockResolvedValue({
    entraOid: employee.entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
  return employee;
}

const json = (method: string, body: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function createDraft(name = "Bid prep"): Promise<string> {
  const res = await POST(json("POST", { name }));
  return ((await res.json()) as { data: { id: string } }).data.id;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetDb();
  await testDb.module.create({
    data: { key: COST_INTELLIGENCE_MODULE_KEY, displayName: "Cost Intelligence", sortOrder: 300 },
  });
  await testDb.cipSkill.create({
    data: {
      name: "Estimate",
      description: "",
      version: 1,
      locationPath: "/skills/estimate",
      folderName: "estimate",
      lastModified: new Date(),
      lastSynced: new Date(),
    },
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(disconnectDb);

describe("access", () => {
  it("401 with no session", async () => {
    authMock.mockResolvedValue(null as never);
    expect((await POST(json("POST", { name: "X" }))).status).toBe(401);
  });

  it("404 on every route for a Member who is not a PCE", async () => {
    await signIn({ grant: true, admin: false });
    expect((await POST(json("POST", { name: "X" }))).status).toBe(404);
    expect((await PATCH(json("PATCH", { name: "Y" }), ctx("1"))).status).toBe(404);
    expect((await DELETE(json("DELETE", {}), ctx("1"))).status).toBe(404);
    expect((await PUT(json("PUT", { steps: [] }), ctx("1"))).status).toBe(404);
    expect(await testDb.cipWorkflow.count()).toBe(0);
  });
});

describe("as a PCE", () => {
  beforeEach(() => signIn({ grant: true, admin: true }));

  it("POST creates a draft owned by the caller and returns 201", async () => {
    const res = await POST(json("POST", { name: "Bid prep", description: "For bids" }));
    expect(res.status).toBe(201);
    const row = await testDb.cipWorkflow.findFirstOrThrow();
    expect(row).toMatchObject({ name: "Bid prep", description: "For bids", status: "draft" });
    expect(row.createdById).not.toBeNull();
  });

  it("422 for a bad body: not JSON, wrong types, or an unknown field", async () => {
    expect((await POST(json("POST", "not json"))).status).toBe(422);
    expect((await POST(json("POST", { name: 5 }))).status).toBe(422);
    expect((await POST(json("POST", { name: "X", owner: "me" }))).status).toBe(422);
    expect((await PATCH(json("PATCH", { status: "archived" }), ctx("1"))).status).toBe(422);
    expect((await PUT(json("PUT", { steps: "estimate" }), ctx("1"))).status).toBe(422);
  });

  it("maps service refusals to their status codes", async () => {
    const id = await createDraft();

    const taken = await POST(json("POST", { name: "BID PREP" }));
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: { code: "name_taken" } });

    expect((await PATCH(json("PATCH", { status: "active" }), ctx(id))).status).toBe(409);
    expect((await PUT(json("PUT", { steps: ["nope"] }), ctx(id))).status).toBe(422);
    expect((await PATCH(json("PATCH", { name: "X" }), ctx("abc"))).status).toBe(404);
    expect((await DELETE(json("DELETE", {}), ctx("999"))).status).toBe(404);
  });

  it("PUT steps, activate, then DELETE is refused until it is a draft", async () => {
    const id = await createDraft();

    const put = await PUT(json("PUT", { steps: ["estimate"] }), ctx(id));
    expect(await put.json()).toEqual({ data: { changed: true } });

    expect((await PATCH(json("PATCH", { status: "active" }), ctx(id))).status).toBe(200);

    const del = await DELETE(json("DELETE", {}), ctx(id));
    expect(del.status).toBe(409);
    expect(await del.json()).toMatchObject({ error: { code: "not_draft" } });
  });

  it("DELETE removes a draft", async () => {
    const id = await createDraft();
    expect((await DELETE(json("DELETE", {}), ctx(id))).status).toBe(200);
    expect(await testDb.cipWorkflow.count()).toBe(0);
  });
});

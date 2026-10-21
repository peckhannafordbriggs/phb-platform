import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard, the queries and the route handlers
// are the real ones. No review credential is configured in the suite, so
// these stop at the authorization boundary or at "not configured" - which is
// exactly the contract being tested: the app boots and serves without the
// folder grant, and says so in one shape.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { GET as listingRoute } from "@/app/api/modules/change-orders/review/route";
import { GET as countRoute } from "@/app/api/modules/change-orders/review/count/route";
import { GET as noteRoute } from "@/app/api/modules/change-orders/review/notes/[noteId]/route";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  resetDb,
  seedChangeOrdersModule,
} from "./db";

const authMock = vi.mocked(auth);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

const url = (path: string) => new Request(`http://localhost${path}`);

/** Every review route, called the way Next calls it. */
const ROUTES: Array<{ name: string; call: () => Promise<Response> }> = [
  { name: "listing", call: () => listingRoute() },
  { name: "count", call: () => countRoute() },
  {
    name: "note",
    call: () =>
      noteRoute(url("/api/modules/change-orders/review/notes/n"), {
        params: Promise.resolve({ noteId: "note-1" }),
      }),
  },
];

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetDb();
  await seedChangeOrdersModule();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

describe("every review route is behind the Change Orders grant", () => {
  for (const route of ROUTES) {
    it(`${route.name}: 401 when unauthenticated`, async () => {
      authMock.mockResolvedValue(null as never);

      expect((await route.call()).status).toBe(401);
    });

    it(`${route.name}: 404 - not 403 - without the grant`, async () => {
      await createEmployee({ entraOid: `oid-nogrant-${route.name}` });
      signedInAs(`oid-nogrant-${route.name}`);

      // 404 so the platform does not confirm the module exists.
      expect((await route.call()).status).toBe(404);
    });

    it(`${route.name}: 403 when the profile is incomplete`, async () => {
      const employee = await createEmployee({
        entraOid: `oid-incomplete-${route.name}`,
        profileCompleted: false,
      });
      await grantModule(employee.id);
      signedInAs(`oid-incomplete-${route.name}`);

      expect((await route.call()).status).toBe(403);
    });

    it(`${route.name}: reports "not configured" with a grant but no folder access`, async () => {
      const employee = await createEmployee({ entraOid: `oid-granted-${route.name}` });
      await grantModule(employee.id);
      signedInAs(`oid-granted-${route.name}`);

      const response = await route.call();
      const body = (await response.json()) as { error: { code: string; message: string } };

      // The suite leaves the review variables unset, which is the state the
      // platform boots and serves in until the folder grant lands. Every
      // review route answers the same way, so the tab renders one
      // "not connected" state rather than a failure per pane.
      expect(body.error.code).toBe("review_not_configured");
      expect(body.error.message).not.toContain("PHB_PLATFORM");
      expect(body.error.message).not.toContain("Graph");
      expect(body.error.message).toMatch(/SharePoint/);
    });
  }

  it("reveals nothing about the folder or the mailbox to an ungranted caller", async () => {
    await createEmployee({ entraOid: "oid-quiet" });
    signedInAs("oid-quiet");

    const raw = JSON.stringify(await (await listingRoute()).json());

    expect(raw).not.toContain("_needs_review");
    expect(raw).not.toContain("SharePoint");
    expect(raw).not.toContain("changeorder");
    expect(raw).not.toContain("PHB_PLATFORM");
  });
});

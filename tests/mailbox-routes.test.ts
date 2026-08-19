import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Only the session is mocked. The guard, the queries and the route handlers are
// the real ones. No Graph credential is configured in the suite, so these stop
// at the authorization boundary or at "not configured" - which is exactly the
// contract being tested.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { GET as foldersRoute } from "@/app/api/modules/change-orders/folders/route";
import { GET as messagesRoute } from "@/app/api/modules/change-orders/folders/[folderId]/messages/route";
import { GET as messageRoute } from "@/app/api/modules/change-orders/messages/[messageId]/route";
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

/** Every mail route, called the way Next calls it. */
const ROUTES: Array<{ name: string; call: () => Promise<Response> }> = [
  { name: "folders", call: () => foldersRoute() },
  {
    name: "folder messages",
    call: () =>
      messagesRoute(url("/api/modules/change-orders/folders/f/messages"), {
        params: Promise.resolve({ folderId: "folder-1" }),
      }),
  },
  {
    name: "message detail",
    call: () =>
      messageRoute(url("/api/modules/change-orders/messages/m"), {
        params: Promise.resolve({ messageId: "message-1" }),
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

describe("every mail route is behind the module grant", () => {
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

    it(`${route.name}: reports "not configured" with a grant but no credential`, async () => {
      const employee = await createEmployee({ entraOid: `oid-granted-${route.name}` });
      await grantModule(employee.id);
      signedInAs(`oid-granted-${route.name}`);

      const response = await route.call();
      const body = (await response.json()) as {
        error: { code: string; message: string };
      };

      // The suite leaves GRAPH_* unset, which is the state the platform has to
      // boot and serve in. Every mail route answers the same way, so the UI
      // renders one "not connected" state rather than a failure per pane.
      expect(body.error.code).toBe("mail_not_configured");
      expect(body.error.message).not.toContain("GRAPH_");
      expect(body.error.message).not.toContain("Graph");
    });
  }

  it("reveals nothing about the mailbox to an ungranted caller", async () => {
    await createEmployee({ entraOid: "oid-quiet" });
    signedInAs("oid-quiet");

    const raw = JSON.stringify(await (await foldersRoute()).json());

    expect(raw).not.toContain("changeorder");
    expect(raw).not.toContain("GRAPH_");
    expect(raw).not.toContain("mailbox");
  });
});

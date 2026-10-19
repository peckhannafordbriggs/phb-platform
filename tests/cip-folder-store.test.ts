import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharePointError, sharePointStore, type GraphFetch } from "@/lib/modules/cost-intelligence/folder-store";

/**
 * A fake Graph over one drive "d" whose granted folder is item "root":
 *   root/ SKILL.md, a/ (CHANGELOG.md, Archive/old.txt, deep/x.txt)
 * The root's children come back in two pages, and the first request is throttled once.
 */
type Node = { id: string; name: string; children?: Node[]; content?: string; modified: string };
const tree: Node = {
  id: "root",
  name: "BID-DOC",
  modified: "2026-10-01T00:00:00Z",
  children: [
    { id: "f1", name: "SKILL.md", content: "---\nname: x\n---", modified: "2026-10-02T00:00:00Z" },
    {
      id: "a",
      name: "a",
      modified: "2026-10-03T00:00:00Z",
      children: [
        { id: "f2", name: "CHANGELOG.md", content: "## 1", modified: "2026-10-04T00:00:00Z" },
        { id: "arch", name: "Archive", modified: "2026-10-01T00:00:00Z", children: [{ id: "f3", name: "old.txt", content: "old", modified: "2026-10-01T00:00:00Z" }] },
        { id: "deep", name: "deep", modified: "2026-10-01T00:00:00Z", children: [{ id: "f4", name: "x.txt", content: "xx", modified: "2026-10-05T00:00:00Z" }] },
      ],
    },
  ],
};

function find(node: Node, parts: string[]): Node | undefined {
  if (parts.length === 0) return node;
  const next = node.children?.find((c) => c.name === parts[0]);
  return next && find(next, parts.slice(1));
}
function byId(node: Node, id: string): Node | undefined {
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const hit = byId(c, id);
    if (hit) return hit;
  }
  return undefined;
}

const graphItem = (n: Node) => ({
  id: n.id,
  name: n.name,
  ...(n.children ? { folder: { childCount: n.children.length } } : { file: {}, size: n.content!.length }),
  webUrl: `https://phb.sharepoint.com/${n.name}`,
  fileSystemInfo: { lastModifiedDateTime: n.modified },
});

function fakeGraph() {
  const calls: string[] = [];
  let throttled = false;
  const fetchImpl: GraphFetch = async (url, init) => {
    calls.push(url);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer t");
    if (!throttled) {
      throttled = true;
      return new Response("", { status: 429, headers: { "retry-after": "0" } });
    }
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname.replace("/v1.0", ""));
    if (p.startsWith("/shares/")) return Response.json({ id: "root", parentReference: { driveId: "d" } });

    const byPath = /^\/drives\/d\/items\/root(?::\/(.*):)?\/(children|content)$/.exec(p);
    const byIdMatch = /^\/drives\/d\/items\/([^/:]+)\/content$/.exec(p);
    const node = byPath ? find(tree, (byPath[1] ?? "").split("/").filter(Boolean)) : byIdMatch ? byId(tree, byIdMatch[1]!) : undefined;
    if (!node) return Response.json({ error: { code: "itemNotFound", message: "nope" } }, { status: 404 });
    if ((byPath?.[2] ?? "content") === "content") return new Response(node.content ?? "");

    const children = node.children!.map(graphItem);
    if (node.id === "root" && !u.searchParams.has("page")) {
      return Response.json({ value: children.slice(0, 1), "@odata.nextLink": `${u.origin}${u.pathname}?page=2` });
    }
    return Response.json({ value: node.id === "root" ? children.slice(1) : children });
  };
  return { fetchImpl, calls };
}

const token = async () => "t";
let dest: string | null = null;
afterEach(async () => {
  if (dest) await rm(dest, { recursive: true, force: true });
  dest = null;
});

describe("sharePointStore", () => {
  it("lists a folder across pages, after a throttled first try", async () => {
    const { fetchImpl } = fakeGraph();
    const store = sharePointStore("ids:d/root", token, fetchImpl);
    const entries = await store.list("");
    expect(entries.map((e) => [e.name, e.folder])).toEqual([["SKILL.md", false], ["a", true]]);
    expect(entries[0]).toMatchObject({ size: 15, location: "https://phb.sharepoint.com/SKILL.md", modified: new Date("2026-10-02T00:00:00Z") });
    expect((await store.list("a")).map((e) => e.name)).toEqual(["CHANGELOG.md", "Archive", "deep"]);
  });

  it("reads a text file by path, and gives null for a missing one", async () => {
    const { fetchImpl } = fakeGraph();
    const store = sharePointStore("ids:d/root", token, fetchImpl);
    expect(await store.read("a/CHANGELOG.md")).toBe("## 1");
    expect(await store.read("a/SKILL.md")).toBeNull();
  });

  it("downloads a folder tree, leaving out skipped names", async () => {
    const { fetchImpl } = fakeGraph();
    const store = sharePointStore("ids:d/root", token, fetchImpl);
    dest = await mkdtemp(path.join(tmpdir(), "cip-store-"));
    await store.download("a", path.join(dest, "copy"), /^archive$/i);
    expect((await readdir(path.join(dest, "copy"))).sort()).toEqual(["CHANGELOG.md", "deep"]);
    expect(await readFile(path.join(dest, "copy", "deep", "x.txt"), "utf8")).toBe("xx");
  });

  it("finds the folder from its URL through /shares", async () => {
    const { fetchImpl, calls } = fakeGraph();
    const store = sharePointStore("https://phb.sharepoint.com/sites/AI Sandbox/Shared Documents/BID-DOC", token, fetchImpl);
    expect(await store.read("SKILL.md")).toContain("name: x");
    expect(calls.some((c) => c.includes("/shares/u!"))).toBe(true);
  });

  it("says plainly when the folder is not granted", async () => {
    const store = sharePointStore("ids:d/root", token, async () =>
      Response.json({ error: { code: "accessDenied", message: "Access denied" } }, { status: 403 }),
    );
    await expect(store.list("")).rejects.toThrow(SharePointError);
    await expect(store.list("")).rejects.toThrow(/403.*no grant on this folder/);
  });
});

describe("limiter", () => {
  it("never runs more than n tasks at once, and runs them all", async () => {
    const { limiter } = await import("@/lib/modules/cost-intelligence/folder-store");
    const limit = limiter(3);
    let active = 0;
    let peak = 0;
    const done = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        limit(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return i;
        }),
      ),
    );
    expect(done).toEqual([...Array(12).keys()]);
    expect(peak).toBe(3);
  });

  it("keeps going after a task fails", async () => {
    const { limiter } = await import("@/lib/modules/cost-intelligence/folder-store");
    const limit = limiter(1);
    await expect(limit(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await limit(async () => "next")).toBe("next");
  });
});

describe("write", () => {
  it("only creates files inside a project's AI FILES, locally", async () => {
    const { localStore, FileExistsError } = await import("@/lib/modules/cost-intelligence/folder-store");
    dest = await mkdtemp(path.join(tmpdir(), "cip-write-"));
    const { mkdir: mk } = await import("node:fs/promises");
    await mk(path.join(dest, "Job"));
    const store = localStore(dest);

    await store.write("Job/AI FILES/sub/a.txt", Buffer.from("1"));
    expect(await readFile(path.join(dest, "Job", "AI FILES", "sub", "a.txt"), "utf8")).toBe("1");
    await expect(store.write("Job/AI FILES/sub/a.txt", Buffer.from("2"))).rejects.toBeInstanceOf(FileExistsError);
    expect(await readFile(path.join(dest, "Job", "AI FILES", "sub", "a.txt"), "utf8")).toBe("1");

    for (const bad of ["Job/ESTIMATE/a.txt", "Job/a.txt", "AI FILES/a.txt", "Job/AI FILES/../ESTIMATE/a.txt", "Job/AI FILES/./a.txt", "Job/AI FILES", "Job//AI FILES/a.txt", "Job/AI FILES/a\\..\\b.txt"]) {
      await expect(store.write(bad, Buffer.from("x"))).rejects.toThrow(/Refused to write outside/);
    }
    await expect(store.write("Nope/AI FILES/a.txt", Buffer.from("x"))).rejects.toThrow(); // project must exist
  });

  it("creates AI FILES folders then uploads with fail-on-conflict, on SharePoint", async () => {
    const { sharePointStore, FileExistsError } = await import("@/lib/modules/cost-intelligence/folder-store");
    const calls: { method: string; url: string; body?: string }[] = [];
    let uploads = 0;
    const store = sharePointStore("ids:d/root", token, async (url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: decodeURIComponent(url), body: typeof init?.body === "string" ? init.body : undefined });
      if (method === "POST") return new Response("{}", { status: url.includes("/root:/Job:/") ? 201 : 409 });
      uploads += 1;
      return new Response("{}", { status: uploads === 1 ? 201 : 409 });
    });

    await store.write("Job/AI FILES/claude/r.md", Buffer.from("x"));
    await expect(store.write("Job/AI FILES/claude/r.md", Buffer.from("y"))).rejects.toBeInstanceOf(FileExistsError);
    await expect(store.write("Job/ESTIMATE/e.xlsx", Buffer.from("z"))).rejects.toThrow(/Refused/);

    expect(calls.filter((c) => c.method === "POST").map((c) => [c.url.replace(/^.*\/items\/root/, ""), JSON.parse(c.body!).name])).toEqual([
      [":/Job:/children", "AI FILES"],
      [":/Job/AI FILES:/children", "claude"],
    ]);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[0]!.url).toContain("/items/root:/Job/AI FILES/claude/r.md:/content?@microsoft.graph.conflictBehavior=fail");
    expect(calls.some((c) => c.url.includes("ESTIMATE"))).toBe(false);
  });
});

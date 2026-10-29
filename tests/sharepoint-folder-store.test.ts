import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  localStore,
  readOnly,
  SharePointError,
  sharePointStore,
  type GraphFetch,
} from "@/lib/sharepoint/folder-store";

/**
 * What the shared store adds for the Knowledge Base: a stable id, a content
 * tag for change detection, single-file download, a whole drive as the root,
 * and a read-only view. tests/cip-folder-store.test.ts still covers the rest
 * through CIP's re-export.
 */

const token = async () => "t";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "zztest-store-"));
  dirs.push(dir);
  return dir;
}

describe("localStore", () => {
  it("gives a relative-path id and a size:mtime content tag", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, "P", "11 - SUBMITTALS"), { recursive: true });
    const file = path.join(root, "P", "11 - SUBMITTALS", "a.pdf");
    await writeFile(file, "12345");
    await utimes(file, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

    const [folder] = await localStore(root).list("P");
    expect(folder).toMatchObject({ id: "P/11 - SUBMITTALS", folder: true, contentTag: null });
    const [entry] = await localStore(root).list("P/11 - SUBMITTALS");
    expect(entry).toMatchObject({
      id: "P/11 - SUBMITTALS/a.pdf",
      contentTag: `5:${Date.parse("2026-01-01T00:00:00Z")}`,
    });
  });

  it("downloads one file", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, "P"));
    await writeFile(path.join(root, "P", "a.txt"), "hello");
    const dest = path.join(await tempDir(), "x", "a.txt");
    await localStore(root).downloadFile("P/a.txt", dest);
    expect(await readFile(dest, "utf8")).toBe("hello");
  });
});

describe("readOnly", () => {
  it("carries no write at all", async () => {
    const view = readOnly(localStore(await tempDir()));
    expect("write" in view).toBe(false);
    expect(Object.keys(view).sort()).toEqual(["download", "downloadFile", "list", "read"]);
  });
});

describe("sharePointStore", () => {
  function fakeGraph(): { fetchImpl: GraphFetch; urls: string[] } {
    const urls: string[] = [];
    const fetchImpl: GraphFetch = async (url) => {
      urls.push(url);
      if (url.includes("/children")) {
        return Response.json({
          value: [
            { id: "item-1", name: "a.pdf", file: {}, size: 3, cTag: "c1", eTag: "e1", webUrl: "https://x/a.pdf" },
            { id: "item-2", name: "11 - SUBMITTALS", folder: { childCount: 1 }, cTag: "c2" },
          ],
        });
      }
      if (url.endsWith("/content")) return new Response("pdf");
      return new Response("{}", { status: 404 });
    };
    return { fetchImpl, urls };
  }

  it("treats ids:<driveId> as the whole drive", async () => {
    const { fetchImpl, urls } = fakeGraph();
    await sharePointStore("ids:drive-1", token, fetchImpl).list("");
    expect(urls[0]).toMatch(/\/drives\/drive-1\/items\/root\/children\?/);
  });

  it("gives the driveItem id and the cTag, and no tag for a folder", async () => {
    const { fetchImpl } = fakeGraph();
    const entries = await sharePointStore("ids:drive-1", token, fetchImpl).list("");
    expect(entries.map((e) => [e.id, e.contentTag])).toEqual([
      ["item-1", "c1"],
      ["item-2", null],
    ]);
  });

  it("downloads one file by path", async () => {
    const { fetchImpl, urls } = fakeGraph();
    const dest = path.join(await tempDir(), "deep", "a.pdf");
    await sharePointStore("ids:drive-1/f", token, fetchImpl).downloadFile("P/a b.pdf", dest);
    expect(urls.at(-1)).toBe("https://graph.microsoft.com/v1.0/drives/drive-1/items/f:/P/a%20b.pdf:/content");
    expect(await readFile(dest, "utf8")).toBe("pdf");
  });

  it("names the module's own app in a 403", async () => {
    const store = sharePointStore("ids:drive-1", token, async () => new Response("{}", { status: 403 }), {
      app: "KB",
    });
    await expect(store.list("")).rejects.toThrow(/The KB app has no grant/);
  });

  it("refuses a malformed ids: value", async () => {
    await expect(sharePointStore("ids:d/", token).list("")).rejects.toBeInstanceOf(SharePointError);
    await expect(sharePointStore("ids:d/a/b", token).list("")).rejects.toBeInstanceOf(SharePointError);
  });
});

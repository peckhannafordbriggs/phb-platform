import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  localStore,
  normalizeFolderUrl,
  readOnly,
  resolveSharePointFolder,
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

/**
 * A folder URL as people copy it (2026-11-16): the address bar of a library
 * view, a folder URL with %20 in it, or one typed with spaces, all reach
 * /shares as the same folder, encoded once. The KB's folder is named
 * "+++CURATED_FOLDERS", so the "+" must survive too.
 */
describe("folder URLs as copied from the browser", () => {
  const SITE = "https://phb1899.sharepoint.com";
  const FOLDER = `${SITE}/sites/KnowledgeBase/Shared Documents/+++CURATED_FOLDERS`;

  it("reads a library view's id, keeping a plus as a plus", () => {
    const view =
      `${SITE}/sites/KnowledgeBase/Shared%20Documents/Forms/AllItems.aspx` +
      "?id=%2Fsites%2FKnowledgeBase%2FShared%20Documents%2F%2B%2B%2BCURATED_FOLDERS&viewid=1b2c3d4e";
    expect(normalizeFolderUrl(view)).toBe(FOLDER);
    // A literal "+" in the id is a plus, not the space URLSearchParams would make it.
    expect(normalizeFolderUrl(`${SITE}/sites/KnowledgeBase/Shared%20Documents/Forms/AllItems.aspx?id=/sites/KnowledgeBase/Shared%20Documents/+++CURATED_FOLDERS`)).toBe(FOLDER);
  });

  it("reads a view with no id as the library itself", () => {
    expect(normalizeFolderUrl(`${SITE}/sites/KnowledgeBase/Shared%20Documents/Forms/AllItems.aspx`)).toBe(
      `${SITE}/sites/KnowledgeBase/Shared Documents`,
    );
  });

  it("decodes a folder URL once and leaves a typed one alone", () => {
    expect(normalizeFolderUrl(`${SITE}/sites/KnowledgeBase/Shared%20Documents/%2B%2B%2BCURATED_FOLDERS`)).toBe(
      `${SITE}/sites/KnowledgeBase/Shared Documents/%2B%2B%2BCURATED_FOLDERS`,
    );
    expect(normalizeFolderUrl(`  ${FOLDER} `)).toBe(FOLDER);
    expect(normalizeFolderUrl("not a url")).toBe("not a url");
  });

  function sharesGraph() {
    const asked: string[] = [];
    const fetchImpl: GraphFetch = async (url) => {
      const share = /\/shares\/u!([^/]+)\/driveItem/.exec(url)?.[1];
      if (share) {
        asked.push(Buffer.from(share, "base64url").toString("utf8"));
        return Response.json({ id: "item-9", name: "+++CURATED_FOLDERS", webUrl: FOLDER, parentReference: { driveId: "drive-7" } });
      }
      if (url.includes("/drives/drive-7/items/item-9?")) return Response.json({ id: "item-9", name: "+++CURATED_FOLDERS", webUrl: FOLDER });
      if (url.includes("/children")) return Response.json({ value: [] });
      return new Response("{}", { status: 404 });
    };
    return { fetchImpl, asked };
  }

  it("sends /shares the folder URL encoded exactly once, whichever form was pasted", async () => {
    const encoded = encodeURI(FOLDER);
    for (const pasted of [
      `${SITE}/sites/KnowledgeBase/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FKnowledgeBase%2FShared%20Documents%2F%2B%2B%2BCURATED_FOLDERS&viewid=x`,
      `${SITE}/sites/KnowledgeBase/Shared%20Documents/+++CURATED_FOLDERS`,
      FOLDER,
    ]) {
      const { fetchImpl, asked } = sharesGraph();
      expect(await resolveSharePointFolder(pasted, token, fetchImpl, "KB")).toEqual({
        driveId: "drive-7",
        itemId: "item-9",
        name: "+++CURATED_FOLDERS",
        webUrl: FOLDER,
      });
      expect(asked).toEqual([encoded]);
    }
    // The store resolves its root the same way.
    const { fetchImpl, asked } = sharesGraph();
    await sharePointStore(`${SITE}/sites/KnowledgeBase/Shared%20Documents/+++CURATED_FOLDERS`, token, fetchImpl).list("");
    expect(asked).toEqual([encoded]);
  });

  it("checks an ids: value against SharePoint and names the KB app on a 403", async () => {
    const { fetchImpl } = sharesGraph();
    expect(await resolveSharePointFolder("ids:drive-7/item-9", token, fetchImpl, "KB")).toMatchObject({ driveId: "drive-7", itemId: "item-9" });
    await expect(resolveSharePointFolder(FOLDER, token, async () => new Response("{}", { status: 403 }), "KB")).rejects.toThrow(
      /The KB app has no grant/,
    );
  });
});

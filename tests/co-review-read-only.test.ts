import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Needs Review is read-only, and this is the test that fails the build if
 * that stops being true (decided 2026-10-21).
 *
 * The reason is the automation's: `_needs_review` is a queue folder Power
 * Automate owns, and the rule in docs/13-needs-review.md §11 is that nothing
 * but Power Automate moves items between queue folders. The platform reading
 * the folder changes no prohibition in CLAUDE.md; the platform writing to it
 * would need a decision this build was told not to make. So the review
 * library and its routes are held to GET, by source text, in three ways.
 *
 * Source-text tests are blunt. That is the point: a method that moves a note
 * could be written many ways, and every one of them has to name an HTTP verb
 * or an SDK verb, and those are the words looked for.
 */

const ROOT = path.resolve(__dirname, "..");
const LIB = path.join(ROOT, "lib/modules/change-orders/review");
const ROUTES = path.join(ROOT, "app/api/modules/change-orders/review");
const UI = [
  path.join(ROOT, "app/(modules)/change-orders/review-client.ts"),
  path.join(ROOT, "app/(modules)/change-orders/review-workspace.tsx"),
  path.join(ROOT, "app/(modules)/change-orders/co-shell.tsx"),
];

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(full)));
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

async function sources(paths: string[]): Promise<Array<{ file: string; text: string }>> {
  return Promise.all(
    paths.map(async (file) => ({ file: path.relative(ROOT, file), text: await readFile(file, "utf8") })),
  );
}

describe("the review library issues GET and nothing else", () => {
  it("has files to check, so the assertions below are not vacuous", async () => {
    expect((await filesUnder(LIB)).length).toBeGreaterThanOrEqual(5);
    expect((await filesUnder(ROUTES)).length).toBeGreaterThanOrEqual(3);
  });

  it("never calls a writing verb on the Graph SDK", async () => {
    for (const { file, text } of await sources(await filesUnder(LIB))) {
      // The SDK's request verbs. `.get(` is the only one allowed.
      expect(text, file).not.toMatch(/\.(post|put|patch|delete|update|create)\s*\(/);
      // And no raw fetch with a method, which is how one would go round the SDK.
      expect(text, file).not.toMatch(/method:\s*["'`](?!GET)/i);
    }
  });

  it("never addresses a Graph endpoint that changes a drive item", async () => {
    for (const { file, text } of await sources(await filesUnder(LIB))) {
      for (const forbidden of ["/copy", "/createUploadSession", "/createLink", "/invite", "/permissions", "/checkin", "/checkout", "/restore", "conflictBehavior"]) {
        expect(text, `${file} mentions ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("has no method on the service that moves, writes, renames, archives or deletes", async () => {
    const service = await readFile(path.join(LIB, "service.ts"), "utf8");
    const methods = [...service.matchAll(/^\s+(?:private\s+)?(?:async\s+)?([a-zA-Z]\w*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/gm)]
      .map((m) => m[1]!)
      .filter((name) => !["constructor", "if", "for", "while", "switch", "catch"].includes(name));

    expect(methods.length).toBeGreaterThan(3);
    for (const name of methods) {
      expect(name, `service method ${name}`).not.toMatch(
        /^(move|write|rename|archive|delete|remove|dismiss|update|create|upload|put|post|patch)/i,
      );
    }
    // What IS there, so a rename of the read methods is noticed too.
    expect(methods).toEqual(expect.arrayContaining(["summary", "listNotes", "readNote"]));
  });

  it("exports GET and no other handler from any review route", async () => {
    for (const { file, text } of await sources(await filesUnder(ROUTES))) {
      expect(text, file).toMatch(/export async function GET\b/);
      expect(text, file).not.toMatch(/export (?:async )?function (POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/);
    }
  });

  it("gives the browser no call that is not a GET, and no button that acts on a note", async () => {
    for (const { file, text } of await sources(UI)) {
      expect(text, file).not.toMatch(/method:\s*["'`](?!GET)/i);
      expect(text, file).not.toMatch(/\b(resolve|dismiss|archive|move|delete)(Note|Item|Review)\b/);
      // Notes render as text, never as markup.
      expect(text, file).not.toContain("dangerouslySetInnerHTML");
    }
  });

  it("never opens an item folder's files, whose names include a live flow trigger", async () => {
    for (const { file, text } of await sources([...(await filesUnder(LIB)), ...(await filesUnder(ROUTES)), ...UI])) {
      // CLAUDE.md prohibition 3 names four filenames the platform must never
      // write. Reading one is not writing it, but the review feature has no
      // reason to name any of them, and a grep that finds one here is a
      // design change somebody should have to explain.
      for (const trigger of ["classification_result.json", "classify_request.json", "scrub_result.json", "vendor_drafts.json", "transfer_ready.json"]) {
        const mentions = text.split(trigger).length - 1;
        const inComments = (text.match(new RegExp(`(?:\\*|//)[^\\n]*${trigger.replace(".", "\\.")}`, "g")) ?? []).length;
        expect(mentions - inComments, `${file} uses ${trigger} outside a comment`).toBe(0);
      }
    }
  });
});

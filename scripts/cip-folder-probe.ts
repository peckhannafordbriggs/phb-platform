import "./load-env";
import { ClientSecretCredential } from "@azure/identity";

/**
 * Can the CIP app registration read the SharePoint folders it was granted?
 *
 * A probe, not an implementation. READ-ONLY: every request is a GET. It writes,
 * moves and deletes nothing.
 *
 * The CIP app holds the granular Graph permissions, not Sites.Selected:
 *
 *   Files.SelectedOperations.Selected   grant on a file or folder
 *   Lists.SelectedOperations.Selected   grant on a list, list item or folder
 *
 * Both need THREE things before anything works: admin consent (the role is in
 * the token), a grant on the specific folder, and the right role on that grant.
 * The probe checks them in that order and says which one failed.
 *
 * A folder-scoped app may not be allowed to look the site up by path, so each
 * folder is located three ways and every attempt is reported:
 *
 *   A. by ids, if given as  ids:<driveId>/<itemId>
 *   B. by path: site by path, then its libraries, then the folder path
 *   C. by URL through the /shares endpoint
 *
 * Then, for each folder that was found: print every file and subfolder under
 * it (recursively, every page), read the first bytes of one file in it, read it again through the Lists path, and try its PARENT, which
 * should be refused. A parent that opens means the access is wider than the
 * folder.
 *
 *   npm run cip:graph:probe
 *   npm run cip:graph:probe -- --folder "<url>" --folder "<url>"
 *   npm run cip:graph:probe -- --limit        (stop each folder at 50 items)
 *   npm run cip:graph:probe -- --limit 200    (or any number)
 *   npm run cip:graph:probe -- --check-write  (write permission, without writing)
 *
 * --check-write asks Graph to create a folder, inside each granted folder, with
 * the name of something already in it and conflictBehavior "fail". Graph
 * checks permission first, then the name: 409 nameAlreadyExists means the app
 * may write, 403 means read-only. Nothing can be created because the name is
 * taken (re-checked just before the request). The permission-before-name order
 * is observed SharePoint behaviour, not a documented guarantee.
 *
 * Folders come from --folder (repeatable) or CIP_SHAREPOINT_TEST_FOLDERS
 * (separated by ;). Each is a folder URL as the browser shows it, a "Copy link"
 * sharing link, or ids:<driveId>/<itemId>.
 *
 * Local only. It authenticates with a client secret, which production must
 * never hold (CLAUDE.md prohibition 7). Prints no token, secret or file content.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPE = "https://graph.microsoft.com/.default";

const EXPECTED_ROLES = ["Files.SelectedOperations.Selected", "Lists.SelectedOperations.Selected"];

/** Roles that would make a pass meaningless, because they reach far more than two folders. */
const BROADER_ROLES = [
  "Sites.Selected",
  "Sites.Read.All",
  "Sites.ReadWrite.All",
  "Sites.Manage.All",
  "Sites.FullControl.All",
  "Files.Read.All",
  "Files.ReadWrite.All",
];

const say = (line = ""): void => void process.stdout.write(`${line}\n`);
const pass = (line: string): void => say(`  PASS  ${line}`);
const fail = (line: string): void => say(`  FAIL  ${line}`);
const warn = (line: string): void => say(`  WARN  ${line}`);
const info = (line: string): void => say(`        ${line}`);

function argValues(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((arg, i) => {
    if (arg === name && i + 1 < process.argv.length) out.push(process.argv[i + 1]);
  });
  return out;
}

interface GraphResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
  error: string;
}

async function graphGet<T>(token: string, path: string): Promise<GraphResult<T>> {
  const response = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (response.ok) return { ok: true, status: response.status, body: json as T, error: "" };

  const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
  const requestId = response.headers.get("request-id") ?? "n/a";
  return {
    ok: false,
    status: response.status,
    body: null,
    error: `${response.status} ${err?.code ?? "unknown"}: ${err?.message ?? text.slice(0, 160)} (request-id ${requestId})`,
  };
}

function decodeClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

interface DriveItem {
  id: string;
  name: string;
  webUrl?: string;
  folder?: { childCount?: number };
  file?: unknown;
  size?: number;
  parentReference?: { driveId?: string; id?: string; path?: string };
  sharepointIds?: { siteId?: string; webId?: string; siteUrl?: string; listId?: string; listItemId?: string };
}

const ITEM_SELECT = "$select=id,name,webUrl,folder,file,size,parentReference,sharepointIds";

/**
 * A folder URL as people actually copy it. The library view puts the real path
 * in ?id=, so ".../Forms/AllItems.aspx?id=/sites/X/Shared Documents/A" means
 * ".../sites/X/Shared Documents/A".
 */
function normaliseFolderUrl(raw: string): string {
  const url = new URL(raw);
  const id = url.searchParams.get("id");
  if (id && id.startsWith("/")) return `${url.origin}${id}`;
  return `${url.origin}${decodeURIComponent(url.pathname)}`;
}

/** True for "Copy link" links (/:f:/s/...), which only the /shares route understands. */
function isSharingLink(raw: string): boolean {
  return /\/:[a-z]:\//i.test(new URL(raw).pathname);
}

function sharesId(url: string): string {
  return `u!${Buffer.from(url, "utf8").toString("base64url")}`;
}

/** A: by ids. */
async function byIds(token: string, raw: string): Promise<GraphResult<DriveItem>> {
  const [driveId, itemId] = raw.slice(4).split("/");
  return graphGet<DriveItem>(token, `/drives/${driveId}/items/${itemId}?${ITEM_SELECT}`);
}

/** B: site by path, then the library whose webUrl prefixes the folder, then the rest of the path. */
async function byPath(token: string, folderUrl: string): Promise<GraphResult<DriveItem>> {
  const url = new URL(folderUrl);
  const match = decodeURIComponent(url.pathname).match(/^\/(sites|teams)\/[^/]+/i);
  if (!match) {
    return { ok: false, status: 0, body: null, error: "URL has no /sites/<name> part" };
  }

  const site = await graphGet<{ id: string }>(token, `/sites/${url.hostname}:${match[0]}?$select=id`);
  if (!site.ok || !site.body) return { ...site, body: null, error: `site lookup: ${site.error}` };

  const drives = await graphGet<{ value: { id: string; name: string; webUrl: string }[] }>(
    token,
    `/sites/${site.body.id}/drives?$select=id,name,webUrl`,
  );
  if (!drives.ok || !drives.body) return { ...drives, body: null, error: `library list: ${drives.error}` };

  const target = folderUrl.toLowerCase();
  const drive = drives.body.value
    .map((d) => ({ ...d, plainUrl: decodeURIComponent(d.webUrl).toLowerCase() }))
    .filter((d) => target.startsWith(`${d.plainUrl}/`) || target === d.plainUrl)
    .sort((a, b) => b.plainUrl.length - a.plainUrl.length)[0];
  if (!drive) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: `no visible library matches the URL (visible: ${drives.body.value.map((d) => d.name).join(", ") || "none"})`,
    };
  }

  const rest = folderUrl.slice(drive.plainUrl.length).replace(/^\/+|\/+$/g, "");
  const encoded = rest.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return graphGet<DriveItem>(
    token,
    encoded ? `/drives/${drive.id}/root:/${encoded}?${ITEM_SELECT}` : `/drives/${drive.id}/root?${ITEM_SELECT}`,
  );
}

/** C: through /shares, which takes a sharing link or a plain URL. */
async function byShares(token: string, url: string): Promise<GraphResult<DriveItem>> {
  return graphGet<DriveItem>(token, `/shares/${sharesId(url)}/driveItem?${ITEM_SELECT}`);
}

/** Proves the role reaches file CONTENT, not just metadata. Reads 256 bytes, prints only the count. */
async function readFirstBytes(token: string, driveId: string, itemId: string): Promise<string | number> {
  const response = await fetch(`${GRAPH}/drives/${driveId}/items/${itemId}/content`, {
    headers: { Authorization: `Bearer ${token}`, Range: "bytes=0-255" },
  });
  if (!response.ok) return `${response.status} ${response.statusText}`;
  return (await response.arrayBuffer()).byteLength;
}

/** A ceiling so a mistyped root cannot walk a whole library. Far above any one job folder. */
const MAX_ITEMS = 20000;

/** --limit on its own means 50; --limit <n> means n. Without the flag, everything (up to MAX_ITEMS). */
const DEFAULT_LIMIT = 50;

function itemLimit(): { max: number; fromFlag: boolean } {
  const i = process.argv.indexOf("--limit");
  if (i < 0) return { max: MAX_ITEMS, fromFlag: false };
  const n = Number(process.argv[i + 1]);
  const max = Number.isInteger(n) && n > 0 ? n : DEFAULT_LIMIT;
  return { max: Math.min(max, MAX_ITEMS), fromFlag: true };
}

const LIMIT = itemLimit();

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

interface WalkResult {
  folders: number;
  files: number;
  bytes: number;
  firstFile: DriveItem | null;
  rootChildren: DriveItem[];
  refused: { path: string; error: string }[];
  rootError: string | null;
  truncated: boolean;
}

/**
 * Prints every file and folder under one folder, depth first, following
 * @odata.nextLink so no page is dropped. A subfolder that refuses (unique
 * permissions inside the granted folder) is reported and the walk carries on.
 */
async function walkFolder(token: string, driveId: string, rootId: string): Promise<WalkResult> {
  const result: WalkResult = {
    folders: 0,
    files: 0,
    bytes: 0,
    firstFile: null,
    rootChildren: [],
    refused: [],
    rootError: null,
    truncated: false,
  };

  async function visit(itemId: string, path: string, depth: number): Promise<void> {
    let url: string | null =
      `/drives/${driveId}/items/${itemId}/children?$select=id,name,folder,file,size&$top=200`;
    const indent = "  ".repeat(depth);

    while (url) {
      const page: GraphResult<{ value: DriveItem[]; "@odata.nextLink"?: string }> = await graphGet(
        token,
        url,
      );
      if (!page.ok || !page.body) {
        if (depth === 1) result.rootError = page.error;
        else {
          result.refused.push({ path, error: page.error });
          info(`${indent}(could not list: ${page.status})`);
        }
        return;
      }
      if (depth === 1) result.rootChildren.push(...page.body.value);

      // Folders first, then files, each by name, so the tree reads the same every run.
      const sorted = [...page.body.value].sort(
        (a, b) => Number(!a.folder) - Number(!b.folder) || a.name.localeCompare(b.name),
      );
      for (const child of sorted) {
        if (result.folders + result.files >= LIMIT.max) {
          result.truncated = true;
          return;
        }
        if (child.folder) {
          result.folders += 1;
          info(`${indent}${child.name}/`);
          await visit(child.id, `${path}/${child.name}`, depth + 1);
        } else {
          result.files += 1;
          result.bytes += child.size ?? 0;
          result.firstFile ??= child;
          info(`${indent}${child.name}  (${formatSize(child.size ?? 0)})`);
        }
      }
      url = page.body["@odata.nextLink"] ?? null;
    }
  }

  await visit(rootId, "", 1);
  return result;
}

const CHECK_WRITE = process.argv.includes("--check-write");

/**
 * Write permission without a write: create-folder with a name that already
 * exists in the granted folder and conflictBehavior "fail". See the header.
 */
async function checkWrite(
  token: string,
  driveId: string,
  folder: DriveItem,
  children: DriveItem[],
): Promise<boolean> {
  const existing = children[0];
  if (!existing) {
    info("Write check: skipped, the folder is empty so there is no existing name to collide with.");
    return true;
  }

  // Re-confirm the name still exists immediately before the request.
  const still = await graphGet<DriveItem>(token, `/drives/${driveId}/items/${existing.id}?$select=id,name`);
  if (!still.ok || still.body?.name !== existing.name) {
    info(`Write check: skipped, "${existing.name}" changed since the listing; not risking a real create.`);
    return true;
  }

  info(`Write check: asking to create a folder named "${existing.name}" (already exists) with conflictBehavior=fail.`);
  const response = await fetch(`${GRAPH}/drives/${driveId}/items/${folder.id}/children`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: existing.name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
  });
  const text = await response.text();

  if (response.status === 409) {
    pass("409 nameAlreadyExists: the app is allowed to write here. Nothing was created.");
    return true;
  }
  if (response.status === 403) {
    pass("403: the grant is read-only. Nothing was created.");
    return true;
  }
  if (response.ok) {
    let created = "?";
    try {
      created = (JSON.parse(text) as { name?: string }).name ?? "?";
    } catch {
      /* keep "?" */
    }
    fail(`Graph CREATED a folder "${created}" in "${folder.name}". Delete it by hand.`);
    info("Write access works, but the no-write check did not hold.");
    return false;
  }
  warn(`Write check: unexpected answer ${response.status}, cannot tell: ${text.slice(0, 160)}`);
  return true;
}

async function probeFolder(token: string, raw: string, n: number): Promise<boolean> {
  say(`Folder ${n}: ${raw}`);

  // --- Locate ----------------------------------------------------------------
  const attempts: [string, () => Promise<GraphResult<DriveItem>>][] = [];
  if (raw.startsWith("ids:")) {
    attempts.push(["A. by ids", () => byIds(token, raw)]);
  } else {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      fail("Not a URL and not ids:<driveId>/<itemId>.");
      return false;
    }
    if (isSharingLink(raw)) {
      attempts.push(["C. by /shares (sharing link)", () => byShares(token, raw)]);
    } else {
      const folderUrl = normaliseFolderUrl(parsed.href);
      info(`Path: ${folderUrl}`);
      attempts.push(["B. by site path", () => byPath(token, folderUrl)]);
      attempts.push(["C. by /shares (URL)", () => byShares(token, encodeURI(folderUrl))]);
    }
  }

  let item: DriveItem | null = null;
  let lastStatus = 0;
  for (const [label, attempt] of attempts) {
    const result = await attempt();
    if (result.ok && result.body) {
      pass(`${label}: found "${result.body.name}"`);
      item ??= result.body;
    } else {
      info(`${label}: ${result.error}`);
      lastStatus = result.status || lastStatus;
    }
  }

  if (!item) {
    fail("Could not open the folder by any route.");
    if (lastStatus === 403) info("403 everywhere: the grant on this folder is missing, or not for this app.");
    if (lastStatus === 404) info("404: check the URL, or the app may simply not see it (SharePoint hides what is not granted).");
    info("If the site lookup is the only problem, retry with ids:<driveId>/<itemId> from Graph Explorer.");
    say();
    return false;
  }

  const driveId = item.parentReference?.driveId;
  if (!driveId) {
    fail("Graph returned the item without a drive id; cannot go further.");
    say();
    return false;
  }
  info(`ids:${driveId}/${item.id}`);
  if (!item.folder) warn("This item is a file, not a folder.");

  // --- List everything, recursively ---------------------------------------------
  say();
  info(`${item.name}/`);
  const walk = await walkFolder(token, driveId, item.id);
  say();
  if (walk.rootError) {
    fail(`List contents: ${walk.rootError}`);
    say();
    return false;
  }
  pass(
    `Listed ${walk.folders} folder(s) and ${walk.files} file(s), ${formatSize(walk.bytes)} in total.`,
  );
  if (walk.truncated) {
    warn(
      LIMIT.fromFlag
        ? `Stopped at ${LIMIT.max} items (--limit). The counts above are partial.`
        : `Stopped at the ${MAX_ITEMS}-item ceiling. The tree is larger than that; the counts above are partial.`,
    );
  }
  if (walk.refused.length > 0) {
    warn(`${walk.refused.length} subfolder(s) could not be listed:`);
    for (const r of walk.refused) info(`${r.path}: ${r.error}`);
  }

  // --- Read file content -------------------------------------------------------
  let ok = walk.refused.length === 0;
  const firstFile = walk.firstFile;
  if (!firstFile) {
    info("Content read: skipped, no file anywhere in this folder.");
  } else {
    const bytes = await readFirstBytes(token, driveId, firstFile.id);
    if (typeof bytes === "number") pass(`Read file content: ${bytes} bytes of "${firstFile.name}"`);
    else {
      fail(`Read file content of "${firstFile.name}": ${bytes}`);
      ok = false;
    }
  }

  // --- Same item through the Lists path ---------------------------------------
  const sp = item.sharepointIds;
  if (sp?.siteId && sp.webId && sp.listId && sp.listItemId && sp.siteUrl) {
    const compositeSite = `${new URL(sp.siteUrl).hostname},${sp.siteId},${sp.webId}`;
    const listItem = await graphGet<{ id: string }>(
      token,
      `/sites/${compositeSite}/lists/${sp.listId}/items/${sp.listItemId}?$select=id`,
    );
    if (listItem.ok) pass("Opened the same folder through the Lists path.");
    else info(`Lists path: ${listItem.error}`);
  } else {
    info("Lists path: skipped, Graph returned no sharepointIds.");
  }

  // --- Scope: the parent should be refused -------------------------------------
  const parentId = item.parentReference?.id;
  if (parentId) {
    const parent = await graphGet<{ value: unknown[] }>(
      token,
      `/drives/${driveId}/items/${parentId}/children?$select=name&$top=1`,
    );
    if (parent.ok) {
      warn("The PARENT folder also opened. Access is wider than this folder (another grant, or a broader role).");
    } else {
      pass(`Parent folder refused (${parent.status}), so access is scoped to this folder.`);
    }
  }

  // --- Write permission (opt-in, no write) ---------------------------------------
  if (CHECK_WRITE && !(await checkWrite(token, driveId, item, walk.rootChildren))) ok = false;

  say();
  return ok;
}

async function main(): Promise<number> {
  if (process.env.NODE_ENV === "production") {
    say("Refusing to run with NODE_ENV=production. This probe uses a client secret and is local only.");
    return 1;
  }

  const folders = [
    ...argValues("--folder"),
    ...(process.env.CIP_SHAREPOINT_TEST_FOLDERS ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean),
  ];

  say("CIP Graph probe: folder-scoped access");
  say(`Mode: ${CHECK_WRITE ? "read + no-write permission check (--check-write)" : "read-only"}`);
  say(LIMIT.fromFlag ? `Listing limit: ${LIMIT.max} items per folder (--limit)` : "Listing limit: none (everything)");
  say();

  // --- 0. Configuration --------------------------------------------------------
  say("0. Configuration");
  const required: Record<string, string | undefined> = {
    PHB_PLATFORM_CIP_APP_TENANT_ID: process.env.PHB_PLATFORM_CIP_APP_TENANT_ID,
    PHB_PLATFORM_CIP_APP_CLIENT_ID: process.env.PHB_PLATFORM_CIP_APP_CLIENT_ID,
    PHB_PLATFORM_CIP_APP_SECRET: process.env.PHB_PLATFORM_CIP_APP_SECRET,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v || v.trim() === "")
    .map(([k]) => k);
  if (folders.length === 0) missing.push("CIP_SHAREPOINT_TEST_FOLDERS (or --folder)");
  if (missing.length > 0) {
    fail(`Missing in .env.local: ${missing.join(", ")}`);
    return 1;
  }
  pass(`Variables present. ${folders.length} folder(s) to test.`);
  say();

  // --- 1. Token and admin consent ---------------------------------------------
  say("1. App-only token (admin consent)");
  let token: string;
  try {
    const credential = new ClientSecretCredential(
      process.env.PHB_PLATFORM_CIP_APP_TENANT_ID!,
      process.env.PHB_PLATFORM_CIP_APP_CLIENT_ID!,
      process.env.PHB_PLATFORM_CIP_APP_SECRET!,
    );
    token = (await credential.getToken(SCOPE)).token;
  } catch (error) {
    fail("Entra refused a token.");
    info(error instanceof Error ? error.message.split("\n")[0] : String(error));
    info("Usually a wrong tenant id, client id or secret, or an expired secret.");
    return 1;
  }

  const claims = decodeClaims(token);
  const roles = Array.isArray(claims.roles) ? (claims.roles as string[]) : [];
  info(`App: ${String(claims.app_displayname ?? "n/a")} (${String(claims.appid ?? "n/a")})`);
  info(`Roles in token: ${roles.length > 0 ? roles.join(", ") : "(none)"}`);

  const consented = EXPECTED_ROLES.filter((r) => roles.includes(r));
  for (const role of EXPECTED_ROLES) {
    if (roles.includes(role)) pass(`${role} is consented.`);
    else warn(`${role} is not in the token.`);
  }
  if (consented.length === 0) {
    fail("Neither granular role is consented. Admin consent is missing (or not yet propagated).");
    return 1;
  }
  const broader = roles.filter((r) => BROADER_ROLES.includes(r));
  if (broader.length > 0) {
    warn(`Token also holds ${broader.join(", ")}. A pass below would not prove the folder grants alone.`);
  }
  say();

  // --- 2. Folders ----------------------------------------------------------------
  say("2. Folders");
  say();
  let allOk = true;
  for (const [i, folder] of folders.entries()) {
    if (!(await probeFolder(token, folder, i + 1))) allOk = false;
  }

  say(allOk ? "Result: every folder opened and read." : "Result: at least one folder failed. See above.");
  return allOk ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    say(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });

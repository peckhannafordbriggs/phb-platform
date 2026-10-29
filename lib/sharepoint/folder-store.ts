import { createWriteStream } from "node:fs";
import { copyFile, cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { ClientAssertionCredential, ClientSecretCredential, type TokenCredential } from "@azure/identity";
import { createManagedIdentityAssertionProvider } from "@/lib/azure/managed-identity-assertion";

/**
 * A folder of documents, read from a local folder (a OneDrive copy, for
 * development) or from SharePoint through Microsoft Graph. Shared by the
 * modules that read SharePoint folders with an application identity of their
 * own: Cost Intelligence (skills, BID-DOC) and the Knowledge Base (the
 * library). Change Orders has its own Graph code and does not use this.
 *
 * The one write is `write`, and it only ever creates a new file under
 * `<project>/AI FILES/`: any other path is refused here, before a request is
 * made, and an existing file is never replaced. There is no delete or move.
 * A module that must never write takes `readOnly(store)`, which does not
 * carry `write` at all.
 *
 * Paths are relative to the store's root, with forward slashes ("" is the root).
 *
 * Each module's app registration has granular permissions
 * (Files.SelectedOperations.Selected) on its own folders only. It authenticates
 * with a client secret locally and, in production, with the platform's managed
 * identity through a federated credential, never a secret.
 */

export type StoreEntry = {
  name: string;
  folder: boolean;
  size: number;
  modified: Date;
  /** For people: a disk path or a SharePoint URL. */
  location: string;
  /**
   * Stable identity. SharePoint: the driveItem id, which survives a rename or
   * move. Local: the path relative to the root, which does not.
   */
  id: string;
  /**
   * Changes when the file's content changes, and only then where the source
   * allows. SharePoint: the cTag (content tag). Local: size and mtime. Null
   * for folders.
   */
  contentTag: string | null;
};

export interface FolderReader {
  /** The entries directly in a folder. Throws if the folder can't be read. */
  list(rel: string): Promise<StoreEntry[]>;
  /** A text file's contents, or null when there is no such file. */
  read(rel: string): Promise<string | null>;
  /** Copy a folder and everything under it to `dest` on disk, leaving out names that match `skip`. */
  download(rel: string, dest: string, skip: RegExp): Promise<void>;
  /** Copy one file to `dest` on disk, streamed, never held whole in memory. */
  downloadFile(rel: string, dest: string): Promise<void>;
}

export interface FolderStore extends FolderReader {
  /**
   * Create a new file at `<project>/AI FILES/...`, making the folders it needs.
   * Refuses any other path; throws FileExistsError rather than replace a file.
   */
  write(rel: string, data: Buffer): Promise<void>;
}

/** The same store with no way to write: `write` is not on the object at all. */
export function readOnly(store: FolderReader): FolderReader {
  return {
    list: (rel) => store.list(rel),
    read: (rel) => store.read(rel),
    download: (rel, dest, skip) => store.download(rel, dest, skip),
    downloadFile: (rel, dest) => store.downloadFile(rel, dest),
  };
}

/** The name the CIP worker gives the outputs folder in each project. */
export const AI_FILES = "AI FILES";

/** The file was already there; nothing was written. */
export class FileExistsError extends Error {
  constructor(readonly rel: string) {
    super(`${rel} already exists; it was not replaced.`);
    this.name = "FileExistsError";
  }
}

/** Throws unless `rel` is a file path inside a project's AI FILES folder. */
export function assertAiFilesPath(rel: string): string[] {
  const parts = rel.split("/");
  const valid =
    parts.length >= 3 &&
    parts.every((p) => p.length > 0 && p !== "." && p !== ".." && !p.includes("\\")) &&
    parts[1]!.toLowerCase() === AI_FILES.toLowerCase();
  if (!valid) throw new Error(`Refused to write outside a project's ${AI_FILES} folder: ${rel}`);
  return parts;
}

/** True for "no such folder" from either store. */
export const isNotFound = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT" || (error instanceof SharePointError && error.status === 404);

const join = (...parts: string[]) => parts.filter(Boolean).join("/");

/**
 * Runs at most `n` tasks at once; the rest wait their turn. Shared across a
 * whole sync so SharePoint sees a steady handful of requests, not a burst.
 * Hold it only around a single request, never across a recursive walk.
 */
export function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= n) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/** Requests to SharePoint in flight at once, per sync or download. */
export const GRAPH_PARALLEL = 8;

// ---------------------------------------------------------------------------
// Local folder
// ---------------------------------------------------------------------------

export function localStore(root: string): FolderStore {
  const full = (rel: string) => path.join(root, ...rel.split("/").filter(Boolean));
  return {
    async list(rel) {
      const dir = full(rel);
      const entries = await readdir(dir, { withFileTypes: true });
      const out: StoreEntry[] = [];
      for (const e of entries) {
        if (!e.isDirectory() && !e.isFile()) continue;
        const location = path.join(dir, e.name);
        const info = await stat(location);
        const file = e.isFile();
        out.push({
          name: e.name,
          folder: e.isDirectory(),
          size: file ? info.size : 0,
          modified: info.mtime,
          location,
          id: join(rel, e.name),
          contentTag: file ? `${info.size}:${Math.trunc(info.mtimeMs)}` : null,
        });
      }
      return out;
    },
    async read(rel) {
      try {
        return await readFile(full(rel), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async download(rel, dest, skip) {
      await cp(full(rel), dest, { recursive: true, filter: (source) => !skip.test(path.basename(source)) });
    },
    async downloadFile(rel, dest) {
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(full(rel), dest);
    },
    async write(rel, data) {
      const parts = assertAiFilesPath(rel);
      await stat(full(parts[0]!)); // the project folder must already exist
      await mkdir(path.dirname(full(rel)), { recursive: true });
      try {
        await writeFile(full(rel), data, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new FileExistsError(rel);
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// SharePoint through Microsoft Graph
// ---------------------------------------------------------------------------

const GRAPH = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const SELECT = "$select=id,name,folder,file,size,webUrl,fileSystemInfo,lastModifiedDateTime,cTag,eTag";
const RETRIES = 4;

export type GraphFetch = (url: string, init?: RequestInit) => Promise<Response>;

type GraphItem = {
  id: string;
  name: string;
  folder?: unknown;
  size?: number;
  webUrl?: string;
  cTag?: string;
  eTag?: string;
  fileSystemInfo?: { lastModifiedDateTime?: string };
  lastModifiedDateTime?: string;
  parentReference?: { driveId?: string };
};

export class SharePointError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SharePointError";
  }
}

export interface SharePointStoreOptions {
  /** Names the app registration in error hints, e.g. "CIP" or "KB". */
  app?: string;
}

/**
 * `folder` is `ids:<driveId>/<itemId>`, `ids:<driveId>` (the drive's root,
 * i.e. a whole library), or the folder's URL as the browser shows it
 * (resolved through /shares).
 */
export function sharePointStore(
  folder: string,
  getToken: () => Promise<string>,
  fetchImpl: GraphFetch = fetch,
  options: SharePointStoreOptions = {},
): FolderStore {
  const app = options.app ?? "CIP";
  let root: Promise<{ driveId: string; itemId: string }> | null = null;
  /** Folders already made (or found) by `write`, so each is asked about once. */
  const made = new Set<string>();

  async function call(url: string, init: { method?: string; body?: Buffer | string; type?: string } = {}): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      const headers: Record<string, string> = { Authorization: `Bearer ${await getToken()}` };
      if (init.type) headers["Content-Type"] = init.type;
      const response = await fetchImpl(url.startsWith("http") ? url : `${GRAPH}${url}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body as BodyInit | undefined,
      });
      const retry = response.status === 429 || response.status === 503 || response.status === 504;
      if (!retry || attempt >= RETRIES) return response;
      const header = Number(response.headers.get("retry-after") ?? Number.NaN);
      const wait = Number.isFinite(header) ? header : 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 30) * 1000));
    }
  }

  async function json<T>(url: string): Promise<T> {
    const response = await call(url);
    if (!response.ok) throw await graphError(response, app);
    return (await response.json()) as T;
  }

  function resolveRoot() {
    root ??= (async () => {
      if (folder.startsWith("ids:")) {
        const [driveId, itemId, extra] = folder.slice(4).split("/");
        if (!driveId || extra !== undefined || itemId === "") {
          throw new SharePointError("The folder must look like ids:<driveId>/<itemId> or ids:<driveId>.", 0);
        }
        return { driveId, itemId: itemId ?? "root" };
      }
      const share = `u!${Buffer.from(encodeURI(folder), "utf8").toString("base64url")}`;
      const item = await json<GraphItem>(`/shares/${share}/driveItem?$select=id,parentReference`);
      const driveId = item.parentReference?.driveId;
      if (!driveId) throw new SharePointError("SharePoint returned the folder without a drive id.", 0);
      return { driveId, itemId: item.id };
    })().catch((error: unknown) => {
      root = null; // let the next call try again
      throw error;
    });
    return root;
  }

  /** The Graph address of the item at `rel` under the root. */
  async function item(rel: string): Promise<string> {
    const { driveId, itemId } = await resolveRoot();
    const parts = rel.split("/").filter(Boolean).map(encodeURIComponent);
    return parts.length === 0 ? `/drives/${driveId}/items/${itemId}` : `/drives/${driveId}/items/${itemId}:/${parts.join("/")}:`;
  }

  async function children(rel: string): Promise<GraphItem[]> {
    const out: GraphItem[] = [];
    let url: string | null = `${await item(rel)}/children?${SELECT}&$top=200`;
    while (url) {
      const page: { value: GraphItem[]; "@odata.nextLink"?: string } = await json(url);
      out.push(...page.value);
      url = page["@odata.nextLink"] ?? null;
    }
    return out;
  }

  const entry = (g: GraphItem): StoreEntry => {
    const folderItem = g.folder !== undefined;
    return {
      name: g.name,
      folder: folderItem,
      size: folderItem ? 0 : (g.size ?? 0),
      modified: new Date(g.fileSystemInfo?.lastModifiedDateTime ?? g.lastModifiedDateTime ?? 0),
      location: g.webUrl ?? g.name,
      id: g.id,
      contentTag: folderItem ? null : (g.cTag ?? g.eTag ?? null),
    };
  };

  /** Streams a response body to `target`, never holding it whole. */
  async function save(response: Response, target: string): Promise<void> {
    if (response.body === null) return writeFile(target, "");
    await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), createWriteStream(target));
  }

  async function fetchFile(id: string): Promise<Response> {
    const { driveId } = await resolveRoot();
    const response = await call(`/drives/${driveId}/items/${id}/content`);
    if (!response.ok) throw await graphError(response, app);
    return response;
  }

  return {
    async list(rel) {
      return (await children(rel)).map(entry);
    },

    async read(rel) {
      const response = await call(`${await item(rel)}/content`);
      if (response.status === 404) return null;
      if (!response.ok) throw await graphError(response, app);
      return response.text();
    },

    async download(rel, dest, skip) {
      // Folders are listed and files fetched in parallel, a few requests at a time.
      const limit = limiter(GRAPH_PARALLEL);
      async function copy(from: string, to: string): Promise<void> {
        await mkdir(to, { recursive: true });
        const entries = await limit(() => children(from));
        await Promise.all(
          entries
            .filter((child) => !skip.test(child.name))
            .map(async (child) => {
              const target = path.join(to, child.name);
              if (child.folder !== undefined) return copy(join(from, child.name), target);
              // Streamed to disk inside the limit, never held whole: a bid project's
              // drawing sets run to hundreds of MB each, and eight of them buffered
              // at once ran the 4 GB worker out of memory (OOMKilled on resume).
              await limit(async () => save(await fetchFile(child.id), target));
            }),
        );
      }
      await copy(rel, dest);
    },

    async downloadFile(rel, dest) {
      await mkdir(path.dirname(dest), { recursive: true });
      const response = await call(`${await item(rel)}/content`);
      if (!response.ok) throw await graphError(response, app);
      await save(response, dest);
    },

    async write(rel, data) {
      const parts = assertAiFilesPath(rel);
      // Create AI FILES and any subfolder; "fail" leaves an existing one alone (409).
      // The project folder (parts[0]) is never created: it has to be there already.
      for (let i = 1; i < parts.length - 1; i += 1) {
        const parent = parts.slice(0, i).join("/");
        if (made.has(`${parent}/${parts[i]}`.toLowerCase())) continue;
        const response = await call(`${await item(parent)}/children`, {
          method: "POST",
          type: "application/json",
          body: JSON.stringify({ name: parts[i], folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
        });
        if (!response.ok && response.status !== 409) throw await graphError(response, app);
        made.add(`${parent}/${parts[i]}`.toLowerCase());
      }
      const response = await call(`${await item(rel)}/content?@microsoft.graph.conflictBehavior=fail`, {
        method: "PUT",
        type: "application/octet-stream",
        body: data,
      });
      if (response.status === 409) throw new FileExistsError(rel);
      if (!response.ok) throw await graphError(response, app);
    },
  };
}

async function graphError(response: Response, app: string): Promise<SharePointError> {
  const text = await response.text().catch(() => "");
  let detail = text.slice(0, 200);
  try {
    const err = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error;
    if (err) detail = `${err.code ?? "error"}: ${err.message ?? ""}`;
  } catch {
    /* keep the raw text */
  }
  const hint =
    response.status === 403
      ? ` The ${app} app has no grant on this folder.`
      : response.status === 404
        ? ` Not found, or not visible to the ${app} app.`
        : "";
  return new SharePointError(`SharePoint answered ${response.status} (${detail}).${hint}`, response.status);
}

// ---------------------------------------------------------------------------
// App credentials
// ---------------------------------------------------------------------------

/** The three variables naming one module's app registration, and its label. */
export interface AppRegistration {
  /** "CIP", "KB": used in messages and as the token cache key. */
  label: string;
  tenantVar: string;
  clientVar: string;
  secretVar: string;
}

export const CIP_APP: AppRegistration = {
  label: "CIP",
  tenantVar: "PHB_PLATFORM_CIP_APP_TENANT_ID",
  clientVar: "PHB_PLATFORM_CIP_APP_CLIENT_ID",
  secretVar: "PHB_PLATFORM_CIP_APP_SECRET",
};

/** A secret locally, the managed identity (federated credential) in production. */
function appCredential(reg: AppRegistration): TokenCredential {
  const tenantId = process.env[reg.tenantVar]?.trim();
  const clientId = process.env[reg.clientVar]?.trim();
  const secret = process.env[reg.secretVar]?.trim();
  if (!tenantId || !clientId) {
    throw new SharePointError(`Set ${reg.tenantVar} and ${reg.clientVar} (see .env.example).`, 0);
  }
  if (process.env.NODE_ENV === "production") {
    if (secret) {
      throw new SharePointError(`${reg.secretVar} must not be set in production; it uses the managed identity.`, 0);
    }
    const assertion = createManagedIdentityAssertionProvider({
      managedIdentityClientId: process.env.GRAPH_MANAGED_IDENTITY_CLIENT_ID?.trim() || null,
    });
    return new ClientAssertionCredential(tenantId, clientId, assertion);
  }
  if (!secret) throw new SharePointError(`Set ${reg.secretVar} for SharePoint access outside production.`, 0);
  return new ClientSecretCredential(tenantId, clientId, secret);
}

const tokenSources = new Map<string, () => Promise<string>>();

/**
 * One credential per app per process; @azure/identity caches the token itself.
 * Keyed by the app's identity as configured, so a changed variable is noticed.
 */
export function appToken(reg: AppRegistration): () => Promise<string> {
  const key = [reg.label, process.env[reg.tenantVar]?.trim(), process.env[reg.clientVar]?.trim()].join("|");
  const cached = tokenSources.get(key);
  if (cached) return cached;
  const credential = appCredential(reg);
  const source = async () => {
    const result = await credential.getToken(GRAPH_SCOPE);
    if (!result) throw new SharePointError(`Entra returned no token for the ${reg.label} app.`, 0);
    return result.token;
  };
  tokenSources.set(key, source);
  return source;
}

// ---------------------------------------------------------------------------
// Which store to use
// ---------------------------------------------------------------------------

export type StoreChoice =
  | { ok: true; store: FolderStore; source: string; kind: "sharepoint" | "local" }
  | { ok: false; message: string };

/**
 * SharePoint when its folder variable is set, else the local folder, else a
 * plain reason. With `localAllowedInProduction: false`, a local folder is
 * refused in production: there it would be an empty disk that looks fine.
 */
export function chooseStore(opts: {
  sharePointVar: string;
  localVar: string;
  what: string;
  app: AppRegistration;
  localAllowedInProduction?: boolean;
}): StoreChoice {
  const folder = process.env[opts.sharePointVar]?.trim();
  if (folder) {
    try {
      return {
        ok: true,
        store: sharePointStore(folder, appToken(opts.app), fetch, { app: opts.app.label }),
        source: `SharePoint (${opts.sharePointVar})`,
        kind: "sharepoint",
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
  const dir = process.env[opts.localVar]?.trim();
  if (dir) {
    if (opts.localAllowedInProduction === false && process.env.NODE_ENV === "production") {
      return { ok: false, message: `${opts.localVar} is not used in production. Set ${opts.sharePointVar}.` };
    }
    return { ok: true, store: localStore(dir), source: dir, kind: "local" };
  }
  return { ok: false, message: `Set ${opts.sharePointVar} (SharePoint) or ${opts.localVar} (a local folder) for the ${opts.what}.` };
}

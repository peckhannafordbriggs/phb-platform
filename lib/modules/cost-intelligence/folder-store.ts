import { createWriteStream } from "node:fs";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { ClientAssertionCredential, ClientSecretCredential, type TokenCredential } from "@azure/identity";
import { createManagedIdentityAssertionProvider } from "@/lib/azure/managed-identity-assertion";

/**
 * Where skills and projects are read from: a local folder (the OneDrive copy,
 * for development) or a SharePoint folder through Microsoft Graph.
 *
 * The one write is `write`, and it only ever creates a new file under
 * `<project>/AI FILES/`: any other path is refused here, before a request is
 * made, and an existing file is never replaced. There is no delete or move.
 *
 * Paths are relative to the store's root, with forward slashes ("" is the root).
 *
 * SharePoint uses the CIP app registration, whose granular permissions
 * (Files.SelectedOperations.Selected) are granted on the two folders only. It
 * authenticates with a client secret locally and, in production, with the
 * platform's managed identity through a federated credential, never a secret.
 */

export type StoreEntry = {
  name: string;
  folder: boolean;
  size: number;
  modified: Date;
  /** For people: a disk path or a SharePoint URL. */
  location: string;
};

export interface FolderStore {
  /** The entries directly in a folder. Throws if the folder can't be read. */
  list(rel: string): Promise<StoreEntry[]>;
  /** A text file's contents, or null when there is no such file. */
  read(rel: string): Promise<string | null>;
  /** Copy a folder and everything under it to `dest` on disk, leaving out names that match `skip`. */
  download(rel: string, dest: string, skip: RegExp): Promise<void>;
  /**
   * Create a new file at `<project>/AI FILES/...`, making the folders it needs.
   * Refuses any other path; throws FileExistsError rather than replace a file.
   */
  write(rel: string, data: Buffer): Promise<void>;
}

/** The name the worker gives the outputs folder in each project. */
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
        out.push({ name: e.name, folder: e.isDirectory(), size: e.isFile() ? info.size : 0, modified: info.mtime, location });
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
const SELECT = "$select=id,name,folder,file,size,webUrl,fileSystemInfo,lastModifiedDateTime";
const RETRIES = 4;

export type GraphFetch = (url: string, init?: RequestInit) => Promise<Response>;

type GraphItem = {
  id: string;
  name: string;
  folder?: unknown;
  size?: number;
  webUrl?: string;
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

/**
 * `folder` is `ids:<driveId>/<itemId>`, or the folder's
 * URL as the browser shows it (resolved through /shares).
 */
export function sharePointStore(
  folder: string,
  getToken: () => Promise<string>,
  fetchImpl: GraphFetch = fetch,
): FolderStore {
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
    if (!response.ok) throw await graphError(response);
    return (await response.json()) as T;
  }

  function resolveRoot() {
    root ??= (async () => {
      if (folder.startsWith("ids:")) {
        const [driveId, itemId] = folder.slice(4).split("/");
        if (!driveId || !itemId) throw new SharePointError("The folder must look like ids:<driveId>/<itemId>.", 0);
        return { driveId, itemId };
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

  const entry = (g: GraphItem): StoreEntry => ({
    name: g.name,
    folder: g.folder !== undefined,
    size: g.folder !== undefined ? 0 : (g.size ?? 0),
    modified: new Date(g.fileSystemInfo?.lastModifiedDateTime ?? g.lastModifiedDateTime ?? 0),
    location: g.webUrl ?? g.name,
  });

  async function fetchFile(id: string): Promise<Response> {
    const { driveId } = await resolveRoot();
    const response = await call(`/drives/${driveId}/items/${id}/content`);
    if (!response.ok) throw await graphError(response);
    return response;
  }

  return {
    async list(rel) {
      return (await children(rel)).map(entry);
    },

    async read(rel) {
      const response = await call(`${await item(rel)}/content`);
      if (response.status === 404) return null;
      if (!response.ok) throw await graphError(response);
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
              await limit(async () => {
                const response = await fetchFile(child.id);
                if (response.body === null) return writeFile(target, "");
                await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), createWriteStream(target));
              });
            }),
        );
      }
      await copy(rel, dest);
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
        if (!response.ok && response.status !== 409) throw await graphError(response);
        made.add(`${parent}/${parts[i]}`.toLowerCase());
      }
      const response = await call(`${await item(rel)}/content?@microsoft.graph.conflictBehavior=fail`, {
        method: "PUT",
        type: "application/octet-stream",
        body: data,
      });
      if (response.status === 409) throw new FileExistsError(rel);
      if (!response.ok) throw await graphError(response);
    },
  };
}

async function graphError(response: Response): Promise<SharePointError> {
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
      ? " The CIP app has no grant on this folder."
      : response.status === 404
        ? " Not found, or not visible to the CIP app."
        : "";
  return new SharePointError(`SharePoint answered ${response.status} (${detail}).${hint}`, response.status);
}

/** The CIP app's credential: a secret locally, the managed identity in production. */
function cipCredential(): TokenCredential {
  const tenantId = process.env.PHB_PLATFORM_CIP_APP_TENANT_ID?.trim();
  const clientId = process.env.PHB_PLATFORM_CIP_APP_CLIENT_ID?.trim();
  const secret = process.env.PHB_PLATFORM_CIP_APP_SECRET?.trim();
  if (!tenantId || !clientId) {
    throw new SharePointError("Set PHB_PLATFORM_CIP_APP_TENANT_ID and PHB_PLATFORM_CIP_APP_CLIENT_ID (see .env.example).", 0);
  }
  if (process.env.NODE_ENV === "production") {
    if (secret) {
      throw new SharePointError("PHB_PLATFORM_CIP_APP_SECRET must not be set in production; it uses the managed identity.", 0);
    }
    const assertion = createManagedIdentityAssertionProvider({
      managedIdentityClientId: process.env.GRAPH_MANAGED_IDENTITY_CLIENT_ID?.trim() || null,
    });
    return new ClientAssertionCredential(tenantId, clientId, assertion);
  }
  if (!secret) throw new SharePointError("Set PHB_PLATFORM_CIP_APP_SECRET for SharePoint access outside production.", 0);
  return new ClientSecretCredential(tenantId, clientId, secret);
}

let tokenSource: (() => Promise<string>) | null = null;

/** One credential per process; @azure/identity caches the token itself. */
function cipToken(): () => Promise<string> {
  if (tokenSource) return tokenSource;
  const credential = cipCredential();
  tokenSource = async () => {
    const result = await credential.getToken(GRAPH_SCOPE);
    if (!result) throw new SharePointError("Entra returned no token for the CIP app.", 0);
    return result.token;
  };
  return tokenSource;
}

// ---------------------------------------------------------------------------
// Which store to use
// ---------------------------------------------------------------------------

export type StoreChoice = { ok: true; store: FolderStore; source: string } | { ok: false; message: string };

/** SharePoint when its folder is set, else the local folder, else a plain reason. */
function choose(sharePointVar: string, localVar: string, what: string): StoreChoice {
  const folder = process.env[sharePointVar]?.trim();
  if (folder) {
    try {
      return { ok: true, store: sharePointStore(folder, cipToken()), source: `SharePoint (${sharePointVar})` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
  const dir = process.env[localVar]?.trim();
  if (dir) return { ok: true, store: localStore(dir), source: dir };
  return { ok: false, message: `Set ${sharePointVar} (SharePoint) or ${localVar} (a local folder) for the ${what}.` };
}

export const skillsStore = () => choose("CIP_SHAREPOINT_SKILLS_FOLDER", "CIP_SKILLS_DIR", "skills folder");
export const projectsStore = () => choose("CIP_SHAREPOINT_PROJECTS_FOLDER", "CIP_PROJECTS_DIR", "BID-DOC folder");

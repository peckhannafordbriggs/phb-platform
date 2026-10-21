import { ResponseType } from "@microsoft/microsoft-graph-client";
import type { Client } from "@microsoft/microsoft-graph-client";
import { logger } from "@/lib/logger";
import { readReviewEnv } from "@/lib/env";
import { createGraphClient, type GraphTransport } from "../graph/client";
import { reviewTokenProvider } from "./credential";
import { ReviewError, toReviewError } from "./errors";
import {
  groupNotes,
  parseNote,
  parseNoteFileName,
  summarise,
  type ReviewGroup,
  type ReviewNote,
  type ReviewSummary,
} from "./notes";

/**
 * The only thing in the codebase that reads the `_needs_review` folder.
 *
 * READ-ONLY, AS A PROPERTY OF THE CLASS AND NOT OF ITS CALLERS. There is no
 * method here that moves, renames, writes or deletes anything, and
 * tests/co-review-read-only.test.ts fails the build if one appears. The
 * reason is in docs/13-needs-review.md §11: `_needs_review` is a queue folder
 * the automation owns, and the standing rule is that Power Automate - not a
 * person, not the classifier, and not this platform - moves items between
 * queue folders. Resolving an item from the platform is Phase 2 and a
 * separate decision; until then a person moves a note to `_archive/` in
 * SharePoint, exactly as the routine says, and this class notices on its
 * next read.
 *
 * What is read: the folder's children (names, sizes, dates), and the text of
 * a note. What is NOT read: the item folders beside the notes, their
 * `body.txt` or their attachments. The email behind a note comes from
 * Exchange through the mail service, where the platform already reads it with
 * the sanitizer and the attachment route that already exist. That keeps this
 * app registration's grant at one folder, and keeps `classification_result.json`
 * - a live flow trigger name - something this code never opens.
 *
 * Nothing is cached beyond the request. Notes are model-written text derived
 * from vendor email; the no-persistence rule for mail covers them.
 */

/** Graph's largest page for a children listing. */
const CHILDREN_PAGE_SIZE = 200;

/**
 * A note is a kilobyte or two. One over this is not a note, whatever it is
 * called, and is refused before its content is requested.
 */
export const MAX_NOTE_BYTES = 64 * 1024;

/** How many notes are read at once when the listing wants their text. */
const READ_PARALLEL = 4;

const CHILD_SELECT = "id,name,size,lastModifiedDateTime,file,folder,webUrl";

interface DriveItem {
  id?: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  webUrl?: string;
  file?: object;
  folder?: object;
  parentReference?: { driveId?: string; id?: string };
}

interface GraphCollection<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

interface FolderRoot {
  driveId: string;
  itemId: string;
}

/** One listing of the folder: the notes, and which item folders sit beside them. */
interface FolderListing {
  notes: NoteMeta[];
  folderNames: Set<string>;
}

type NoteMeta = Omit<ReviewNote, keyof ReturnType<typeof parseNote>>;

export interface ReviewListing {
  summary: ReviewSummary;
  groups: ReviewGroup[];
}

/**
 * The folder, as configured: `ids:<driveId>/<itemId>` or the folder's URL.
 *
 * The same two forms Cost Intelligence accepts, resolved the same way, so the
 * value IT or an operator copies from SharePoint works here unchanged. A
 * `.../AllItems.aspx?id=` link is neither and is refused with the reason.
 */
export function parseFolderSpec(
  folder: string,
): { kind: "ids"; driveId: string; itemId: string } | { kind: "url"; url: string } {
  const trimmed = folder.trim();

  if (trimmed.startsWith("ids:")) {
    const [driveId, itemId, ...rest] = trimmed.slice(4).split("/");
    if (!driveId || !itemId || rest.length > 0) {
      throw new ReviewError("not_configured", {
        detail: "CO_REVIEW_SHAREPOINT_FOLDER must look like ids:<driveId>/<itemId>.",
      });
    }
    return { kind: "ids", driveId, itemId };
  }

  if (/^https:\/\//i.test(trimmed) && !/AllItems\.aspx/i.test(trimmed)) {
    return { kind: "url", url: trimmed };
  }

  throw new ReviewError("not_configured", {
    detail:
      "CO_REVIEW_SHAREPOINT_FOLDER must be ids:<driveId>/<itemId> or the folder's https URL.",
  });
}

/** Graph's sharing-URL encoding: `u!` + base64url of the URL. */
export function shareIdFor(url: string): string {
  return `u!${Buffer.from(url, "utf8").toString("base64url")}`;
}

export class ChangeOrderReviewService {
  private readonly client: Client;
  private readonly folder: string;
  private root: Promise<FolderRoot> | null = null;

  constructor(deps: { client: Client; folder: string }) {
    this.client = deps.client;
    this.folder = deps.folder;
  }

  /**
   * Wraps a Graph call so that every failure leaving this class is a
   * ReviewError. A raw GraphError escaping to a caller would mean the boundary
   * leaked.
   */
  private async call<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const reviewError = toReviewError(error, operation);
      logger.error("review.graph_call_failed", {
        outcome: reviewError.kind,
        reason: reviewError.detail ?? undefined,
        route: operation,
      });
      throw reviewError;
    }
  }

  /**
   * The folder's drive and item ids, resolved once per service and kept.
   *
   * A URL goes through `/shares/{id}/driveItem`, which is how Graph turns a
   * browser URL into an item without the caller knowing the site or drive.
   * A failed resolution is forgotten so the next call tries again rather than
   * remembering a transient failure for the life of the process.
   */
  private resolveRoot(): Promise<FolderRoot> {
    this.root ??= (async () => {
      const spec = parseFolderSpec(this.folder);
      if (spec.kind === "ids") return { driveId: spec.driveId, itemId: spec.itemId };

      const item = await this.call("resolveFolder", () =>
        this.client
          .api(`/shares/${shareIdFor(spec.url)}/driveItem`)
          .select("id,parentReference,folder")
          .get() as Promise<DriveItem>,
      );

      const driveId = item.parentReference?.driveId;
      if (!driveId || !item.id) {
        throw new ReviewError("unexpected", {
          detail: "SharePoint returned the review folder without a drive id.",
        });
      }
      if (item.folder === undefined) {
        throw new ReviewError("not_configured", {
          detail: "CO_REVIEW_SHAREPOINT_FOLDER points at a file, not a folder.",
        });
      }

      return { driveId, itemId: item.id };
    })().catch((error: unknown) => {
      this.root = null;
      throw error;
    });

    return this.root;
  }

  private async listing(): Promise<FolderListing> {
    const { driveId, itemId } = await this.resolveRoot();

    const notes: NoteMeta[] = [];
    const folderNames = new Set<string>();

    let page = await this.call("listFolder", () =>
      this.client
        .api(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/children`)
        .select(CHILD_SELECT)
        .top(CHILDREN_PAGE_SIZE)
        .get() as Promise<GraphCollection<DriveItem>>,
    );

    for (;;) {
      for (const item of page.value ?? []) {
        const name = item.name ?? "";
        if (item.folder !== undefined) {
          folderNames.add(name);
          continue;
        }
        // `.keep.txt`, and anything else that is not a note, is skipped here.
        // The count is the count of notes, and nothing else in the folder is
        // one - docs/13-needs-review.md §3.
        const parsed = parseNoteFileName(name);
        if (parsed === null || item.id === undefined) continue;

        notes.push({
          id: item.id,
          fileName: name,
          itemId: parsed.itemId,
          fileDate: parsed.receivedDate,
          fileTime: parsed.receivedTime,
          fileMessageIdHint: parsed.messageIdHint,
          sizeBytes: item.size ?? 0,
          lastModified: item.lastModifiedDateTime ?? null,
          webUrl: item.webUrl ?? null,
          hasItemFolder: false,
        });
      }

      const next = page["@odata.nextLink"];
      if (next === undefined) break;

      page = await this.call("listFolder.page", () =>
        this.client.api(next).get() as Promise<GraphCollection<DriveItem>>,
      );
    }

    for (const note of notes) {
      note.hasItemFolder = folderNames.has(note.itemId);
    }

    return { notes, folderNames };
  }

  /**
   * The count and the dates beside it, from the folder listing alone. This is
   * what the tab bar polls, so it is one request (plus paging) and reads no
   * note.
   */
  async summary(): Promise<ReviewSummary> {
    const { notes } = await this.listing();
    return summarise(notes);
  }

  /** Every note, read and parsed, grouped by subject. */
  async listNotes(): Promise<ReviewListing> {
    const { notes } = await this.listing();

    const read: ReviewNote[] = [];
    // A bounded fan-out rather than Promise.all over the whole folder: the
    // backlog is fourteen notes today, and the day it is a hundred is not the
    // day to find out what SharePoint does with a hundred concurrent reads.
    for (let start = 0; start < notes.length; start += READ_PARALLEL) {
      const batch = notes.slice(start, start + READ_PARALLEL);
      const texts = await Promise.all(batch.map((note) => this.noteText(note)));
      batch.forEach((note, i) => {
        read.push({ ...note, ...parseNote(texts[i]!) });
      });
    }

    return { summary: summarise(read), groups: groupNotes(read) };
  }

  /**
   * One note by its drive item id.
   *
   * The id came from a browser, so it is checked before the content is asked
   * for: it must be a direct child of the review folder, be named like a note
   * and be note-sized. The folder grant already bounds what the token can
   * reach; this is the second reason, and it is the one a test can prove.
   */
  async readNote(noteId: string): Promise<ReviewNote> {
    const { driveId, itemId: folderId } = await this.resolveRoot();

    const item = await this.call("readNote.meta", () =>
      this.client
        .api(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(noteId)}`)
        .select(`${CHILD_SELECT},parentReference`)
        .get() as Promise<DriveItem>,
    );

    const name = item.name ?? "";
    const parsed = parseNoteFileName(name);
    if (
      item.parentReference?.id !== folderId ||
      item.folder !== undefined ||
      parsed === null ||
      item.id === undefined
    ) {
      throw new ReviewError("not_a_note", {
        detail: `item ${noteId} is not a note in the review folder`,
      });
    }

    const meta: NoteMeta = {
      id: item.id,
      fileName: name,
      itemId: parsed.itemId,
      fileDate: parsed.receivedDate,
      fileTime: parsed.receivedTime,
      fileMessageIdHint: parsed.messageIdHint,
      sizeBytes: item.size ?? 0,
      lastModified: item.lastModifiedDateTime ?? null,
      webUrl: item.webUrl ?? null,
      // One read is for one note; whether its folder exists is the listing's
      // claim, and a single read does not list the folder to make it.
      hasItemFolder: false,
    };

    return { ...meta, ...parseNote(await this.noteText(meta)) };
  }

  private async noteText(note: Pick<NoteMeta, "id" | "sizeBytes" | "fileName">): Promise<string> {
    if (note.sizeBytes > MAX_NOTE_BYTES) {
      throw new ReviewError("not_a_note", {
        detail: `${note.fileName} is ${note.sizeBytes} bytes; a note is under ${MAX_NOTE_BYTES}`,
      });
    }

    const { driveId } = await this.resolveRoot();

    // `/content` answers with a redirect to a pre-authenticated download URL,
    // which the transport follows. The bearer token is not re-sent across that
    // origin change, and the URL is never handed to a browser.
    return (await this.call("readNote.content", () =>
      this.client
        .api(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(note.id)}/content`)
        .responseType(ResponseType.TEXT)
        .get() as Promise<string>,
    )) as string;
  }
}

/**
 * Builds a service.
 *
 * `transport` exists so tests can intercept at the HTTP layer and exercise the
 * real client, the real middleware chain and the real error mapping. The
 * folder always comes from configuration.
 */
export function createReviewService(
  transport?: GraphTransport,
  options: { folder?: string } = {},
): ChangeOrderReviewService {
  let folder = options.folder;
  if (folder === undefined) {
    const reviewEnv = readReviewEnv();
    if (!reviewEnv.present) {
      throw new ReviewError("not_configured", {
        detail: `Missing review configuration: ${reviewEnv.missing.join(", ")}`,
      });
    }
    folder = reviewEnv.values.folder;
  }

  return new ChangeOrderReviewService({
    client:
      transport === undefined
        ? createGraphClient({ tokenProvider: reviewTokenProvider() })
        : createGraphClient(transport),
    folder,
  });
}

let memoisedService: ChangeOrderReviewService | null = null;

/** The process-wide service. Memoised so the token cache behind it persists. */
export function reviewService(): ChangeOrderReviewService {
  if (memoisedService === null) memoisedService = createReviewService();
  return memoisedService;
}

export type ReviewConnectionStatus =
  | { configured: true }
  | { configured: false; missing: string[] };

/**
 * Whether the review folder is configured, without attempting a call.
 *
 * Callers check this instead of catching not_configured, so "IT has not
 * granted the folder yet" is a reported state rather than an error path.
 */
export function reviewConnectionStatus(): ReviewConnectionStatus {
  const reviewEnv = readReviewEnv();
  return reviewEnv.present
    ? { configured: true }
    : { configured: false, missing: reviewEnv.missing };
}

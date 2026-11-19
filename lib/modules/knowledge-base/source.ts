import {
  chooseStore,
  localStore,
  readOnly,
  type AppRegistration,
  type FolderReader,
} from "@/lib/sharepoint/folder-store";
import { KB_LOCAL_SOURCE_DIR_VAR } from "./env";

/**
 * Where the Knowledge Base reads documents from: the Documents library of the
 * Knowledge Base SharePoint site, or locally a synced copy of it (the OneDrive
 * "KB" folder). Each direct subfolder is one project.
 *
 * Read-only by construction: the store is wrapped in `readOnly`, which has no
 * `write`, and the KB app registration is granted read on the library only.
 * docs/KB-P0-P1.md decision 2.
 */

/** The KB's own app registration. Not the CIP, Change Orders or SSO app. */
export const KB_APP: AppRegistration = {
  label: "KB",
  tenantVar: "PHB_PLATFORM_KB_APP_TENANT_ID",
  clientVar: "PHB_PLATFORM_KB_APP_CLIENT_ID",
  secretVar: "PHB_PLATFORM_KB_APP_SECRET",
};

/** `ids:<driveId>` (the whole library), `ids:<driveId>/<itemId>`, or a folder URL. */
export const KB_SHAREPOINT_LIBRARY_URL_VAR = "KB_SHAREPOINT_LIBRARY_URL";

export type KbSource = {
  kind: "sharepoint" | "local";
  store: FolderReader;
  /** For people: which variable or folder it came from. */
  label: string;
};

export type KbSourceChoice = { ok: true; source: KbSource } | { ok: false; message: string };

/** SharePoint when configured, else the local folder outside production, else why not. */
export function kbSource(): KbSourceChoice {
  const choice = chooseStore({
    sharePointVar: KB_SHAREPOINT_LIBRARY_URL_VAR,
    localVar: KB_LOCAL_SOURCE_DIR_VAR,
    what: "Knowledge Base library",
    app: KB_APP,
    localAllowedInProduction: false,
  });
  if (!choice.ok) return choice;
  return { ok: true, source: { kind: choice.kind, store: readOnly(choice.store), label: choice.source } };
}

/** A local folder as the source, regardless of configuration (tests, one-off runs). */
export function localKbSource(directory: string): KbSource {
  return { kind: "local", store: readOnly(localStore(directory)), label: directory };
}

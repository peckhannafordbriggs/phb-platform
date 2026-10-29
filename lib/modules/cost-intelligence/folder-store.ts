/**
 * Cost Intelligence's folders: the skills folder and the BID-DOC projects
 * folder. The store itself is shared with the Knowledge Base and lives in
 * lib/sharepoint/folder-store.ts; this file names CIP's two folders and
 * re-exports the rest so existing imports keep working.
 */
import { chooseStore, CIP_APP } from "@/lib/sharepoint/folder-store";

export {
  AI_FILES,
  assertAiFilesPath,
  FileExistsError,
  GRAPH_PARALLEL,
  isNotFound,
  limiter,
  localStore,
  SharePointError,
  sharePointStore,
  type FolderStore,
  type GraphFetch,
  type StoreChoice,
  type StoreEntry,
} from "@/lib/sharepoint/folder-store";

export const skillsStore = () =>
  chooseStore({ sharePointVar: "CIP_SHAREPOINT_SKILLS_FOLDER", localVar: "CIP_SKILLS_DIR", what: "skills folder", app: CIP_APP });
export const projectsStore = () =>
  chooseStore({ sharePointVar: "CIP_SHAREPOINT_PROJECTS_FOLDER", localVar: "CIP_PROJECTS_DIR", what: "BID-DOC folder", app: CIP_APP });

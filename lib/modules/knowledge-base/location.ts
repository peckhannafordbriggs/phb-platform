/**
 * Where in a file a passage is, in words: "Page 14", "Pages 114-115",
 * "Sheet "Schedule", B4:K40", "Section: 1.3 Submittals". One function for the
 * screen, the re-sort prompt and the answer prompt, so a citation names the
 * same place everywhere. Pure: the browser imports it.
 */
export type KbLocated = {
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  sheet: string | null;
  cellRange: string | null;
};

export function locationLabel(at: KbLocated): string {
  if (at.sheet) return at.cellRange ? `Sheet "${at.sheet}", ${at.cellRange}` : `Sheet "${at.sheet}"`;
  if (at.pageStart !== null) {
    return at.pageEnd !== null && at.pageEnd !== at.pageStart ? `Pages ${at.pageStart}-${at.pageEnd}` : `Page ${at.pageStart}`;
  }
  if (at.section) return `Section: ${at.section}`;
  return "Whole file";
}

/** "Current version", "Older version" or "Archived version", with the version label. */
export function versionText(v: { isLatest: boolean; isArchived: boolean; versionLabel: string | null }): string {
  const kind = v.isArchived ? "Archived version" : v.isLatest ? "Current version" : "Older version";
  return v.versionLabel ? `${kind} (${v.versionLabel})` : kind;
}

/**
 * Working tags at the end of a curated folder's name ("_curated_Test2",
 * "_Test4", "_curated"): how the folders were staged, not part of the
 * project's name. Left out of every name shown (2026-11-16); the folder itself
 * keeps them.
 */
const STAGING_TAGS = /(?:[_ ]curated)?(?:[_ ]test\d*)?$/i;

/**
 * The project's name from its folder: `224070_UC_OLD_CHEM_curated_Test2` is
 * job number 224070, name "UC OLD CHEM". The sync stores it as
 * kb_projects.name and project_number; pure, so labels of old answers are
 * made the same way.
 */
export function projectFromFolder(folder: string): { projectNumber: string | null; projectName: string } {
  const numbered = /^(\d{6})_(.*)$/.exec(folder);
  const rest = numbered?.[2] ?? folder;
  const name = rest.replace(STAGING_TAGS, "").replace(/_/g, " ").trim() || rest.replace(/_/g, " ").trim() || folder;
  return { projectNumber: numbered?.[1] ?? null, projectName: name };
}

/**
 * A project as people say it: job number and name, "221457 MAGNODE", from the
 * folder `221457_MAGNODE_Test4`. The same words in the answer prompt, the
 * answer and the screen, so the screen can find them in the answer and
 * highlight them. Older answer snapshots carry only the folder, so it is the
 * fallback.
 */
export function projectLabel(p: { projectFolder: string; projectNumber?: string | null; projectName?: string | null }): string {
  if (p.projectNumber && p.projectName) return `${p.projectNumber} ${p.projectName}`;
  const { projectNumber, projectName } = projectFromFolder(p.projectFolder);
  return projectNumber ? `${projectNumber} ${projectName}` : projectName;
}

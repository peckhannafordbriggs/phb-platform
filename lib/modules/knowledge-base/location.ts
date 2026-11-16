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
 * A project as people say it: job number and name, "221457 MAGNODE", from the
 * folder `221457_MAGNODE`. The same words in the answer prompt, the answer
 * and the screen, so the screen can find them in the answer and highlight
 * them. Older answer snapshots carry only the folder, so it is the fallback.
 */
export function projectLabel(p: { projectFolder: string; projectNumber?: string | null; projectName?: string | null }): string {
  if (p.projectNumber && p.projectName) return `${p.projectNumber} ${p.projectName}`;
  const numbered = /^(\d{6})_(.*)$/.exec(p.projectFolder);
  const name = (numbered?.[2] ?? p.projectFolder).replace(/_/g, " ").trim() || p.projectFolder;
  return numbered ? `${numbered[1]} ${name}` : name;
}

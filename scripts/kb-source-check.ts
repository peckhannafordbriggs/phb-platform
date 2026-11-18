import "./load-env";

/**
 * Checks the Knowledge Base's SharePoint source as the KB app sees it, and
 * touches no database.
 *
 *   npm run kb:source:check                  KB_SHAREPOINT_LIBRARY_URL
 *   npm run kb:source:check -- "<url>"       a folder URL, as copied from the
 *                                            browser's address bar, or ids:...
 *
 * Signs in as the KB app registration (PHB_PLATFORM_KB_APP_* locally, the
 * managed identity in Azure), finds the folder, and prints:
 *   - the exact `ids:<driveId>/<itemId>` value to configure, which survives a
 *     rename or a move where a URL does not;
 *   - the project folders the sync will index (each direct subfolder), and any
 *     whose name has no six-digit job number;
 *   - files lying directly in the folder, which belong to no project and are
 *     not indexed.
 * A 403 means the app has no read grant there; a 404 that the URL is wrong or
 * the folder is outside what the app can see. runbook.md -> "Pointing the
 * Knowledge Base at its SharePoint folder".
 */

async function main() {
  const { appToken, resolveSharePointFolder, sharePointStore } = await import("../lib/sharepoint/folder-store");
  const { KB_APP, KB_SHAREPOINT_LIBRARY_URL_VAR } = await import("../lib/modules/knowledge-base/source");
  const { projectLabel } = await import("../lib/modules/knowledge-base/location");

  const folder = (process.argv[2] ?? process.env[KB_SHAREPOINT_LIBRARY_URL_VAR] ?? "").trim();
  if (!folder) {
    console.error(`Give a folder URL, or set ${KB_SHAREPOINT_LIBRARY_URL_VAR}.`);
    process.exitCode = 1;
    return;
  }
  const token = appToken(KB_APP);
  console.log(`Looking up the folder as the KB app (${KB_APP.clientVar})...`);
  const found = await resolveSharePointFolder(folder, token, fetch, KB_APP.label);
  const value = `ids:${found.driveId}/${found.itemId}`;
  console.log(`\nFound "${found.name}"${found.webUrl ? ` at ${found.webUrl}` : ""}.`);
  console.log(`\nThe value to configure:\n  ${value}`);
  console.log(`  .env.local:                  ${KB_SHAREPOINT_LIBRARY_URL_VAR}="${value}"`);
  console.log(`  infra/main.parameters.json:  "kbSharePointLibraryUrl": { "value": "${value}" }`);

  const entries = await sharePointStore(value, token, fetch, { app: KB_APP.label }).list("");
  const projects = entries.filter((e) => e.folder).sort((a, b) => a.name.localeCompare(b.name));
  const loose = entries.filter((e) => !e.folder);
  console.log(`\nProjects the sync will index (${projects.length}):`);
  for (const p of projects) {
    const numbered = /^\d{6}_/.test(p.name);
    console.log(`  ${projectLabel({ projectFolder: p.name }).padEnd(48)}${numbered ? "" : "  <- no job number in the name"}`);
  }
  if (projects.length === 0) console.log("  (none: is this the folder that holds the project folders?)");
  if (loose.length > 0) {
    console.log(`\n${loose.length} file(s) directly in the folder belong to no project and are not indexed:`);
    for (const f of loose.slice(0, 10)) console.log(`  ${f.name}`);
    if (loose.length > 10) console.log(`  ... and ${loose.length - 10} more`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

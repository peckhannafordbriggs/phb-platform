/**
 * The PDF chosen on New project, carried to the new project's register. A
 * File cannot travel in a URL, and client navigation keeps this module alive,
 * so New project leaves it here and the import panel picks it up. A reload
 * loses it, and the panel then asks for the file again.
 */
let pending: { projectId: string; file: File } | null = null;

export function handOff(projectId: string, file: File) {
  pending = { projectId, file };
}

/** Not cleared on read: React's development double mount reads it twice. */
export function pendingFile(projectId: string): File | null {
  return pending?.projectId === projectId ? pending.file : null;
}

export function clearHandOff() {
  pending = null;
}

/**
 * Graph reports throttling with Retry-After, either as seconds or as an HTTP
 * date. Anything unparseable is treated as absent rather than as zero.
 *
 * Moved here from lib/modules/change-orders/graph/errors.ts on 2026-11-17,
 * when the Graph client became shared with the BAS report sender; that file
 * re-exports it under its old path.
 */
export function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;

  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.ceil(seconds) : null;
  }

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;

  const delta = Math.ceil((asDate - Date.now()) / 1000);
  return delta > 0 ? delta : 0;
}

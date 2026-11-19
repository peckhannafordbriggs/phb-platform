/**
 * The same passage in more than one file. A submittal often carries a copy
 * of the spec section it answers, and the approved, rejected and resubmitted
 * versions of one submittal carry each other's pages; every copy holds the
 * same words and means the same thing, so without this one paragraph of
 * boilerplate can fill the top of a result list.
 *
 * Two passages are the SAME when their three-word sequences overlap by at
 * least KB_DUPLICATE_SIMILARITY (Jaccard: shared over all). Jaccard, not
 * containment, on purpose: a page holding the boilerplate PLUS a schedule of
 * its own is not a copy of the boilerplate, and must stay a result in its own
 * right. A different header line or page number on the copy costs a few
 * percent; a page with a third of its text its own falls well below.
 *
 * Passages under KB_DUPLICATE_MIN_WORDS words are never collapsed: two short
 * passages that read alike ("Valve schedule.") say too little to be called
 * the same text.
 */

export const KB_DUPLICATE_SIMILARITY = 0.8;
export const KB_DUPLICATE_MIN_WORDS = 30;

const SHINGLE = 3;

/** A passage's three-word sequences, or null when it is too short to compare. */
export function passageShingles(content: string): Set<string> | null {
  const words = content.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length < KB_DUPLICATE_MIN_WORDS) return null;
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= words.length; i += 1) out.add(words.slice(i, i + SHINGLE).join(" "));
  return out;
}

export function shingleSimilarity(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const s of small) if (large.has(s)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function isSamePassage(a: Set<string> | null, b: Set<string> | null): boolean {
  if (a === null || b === null) return false;
  return shingleSimilarity(a, b) >= KB_DUPLICATE_SIMILARITY;
}

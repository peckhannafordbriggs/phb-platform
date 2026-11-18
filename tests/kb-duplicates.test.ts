import { describe, expect, it } from "vitest";
import {
  KB_DUPLICATE_MIN_WORDS,
  isSamePassage,
  passageShingles,
  shingleSimilarity,
} from "@/lib/modules/knowledge-base/duplicates";

const words = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `w${i + from}`).join(" ");

describe("passage duplicates", () => {
  it("calls a copy with a different header the same passage", () => {
    const body = words(200);
    expect(isSamePassage(passageShingles(body), passageShingles(`Project Silver, Trenton OH, June 2 2021. ${body}`))).toBe(true);
  });

  it("ignores case and punctuation", () => {
    const body = words(60);
    expect(isSamePassage(passageShingles(body), passageShingles(body.toUpperCase().replace(/ /g, ", ")))).toBe(true);
  });

  it("does not call a page with a third of its own text a copy", () => {
    const body = words(200);
    const a = passageShingles(body)!;
    const b = passageShingles(`${body} ${words(100, 1000)}`)!;
    expect(shingleSimilarity(a, b)).toBeLessThan(0.7);
    expect(isSamePassage(a, b)).toBe(false);
  });

  it("never compares a passage too short to say anything", () => {
    const short = words(KB_DUPLICATE_MIN_WORDS - 1);
    expect(passageShingles(short)).toBeNull();
    expect(isSamePassage(passageShingles(short), passageShingles(short))).toBe(false);
  });
});

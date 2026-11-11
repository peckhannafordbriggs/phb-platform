import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnswerCard } from "@/app/(modules)/knowledge-base/answer-card";
import type { KbAskedQuestion } from "@/lib/modules/knowledge-base/ask";

/** The answer as a person sees it: citations link to their sources, and nothing is rendered as HTML. */

const asked = (over: Partial<KbAskedQuestion["answer"]> = {}): KbAskedQuestion => ({
  id: "q1",
  conversationId: "c1",
  ordinal: 0,
  question: "What does RTU-3 weigh?",
  askedBy: { id: "e1", name: "Ann A" },
  createdAt: "2026-11-10T16:00:00.000Z",
  scope: { how: "all", projectIds: [] },
  model: "claude-sonnet-5-5",
  durationMs: 4200,
  answer: {
    version: 1,
    kind: "answered",
    text: "About 375 LBS [1]; the rejected submittal said 410 [2].\n- Length 172.5 in [1]",
    missing: null,
    conflicts: [],
    searchedFor: "What does RTU-3 weigh?",
    considered: 3,
    notices: [],
    sources: [1, 2].map((n) => ({
      n,
      chunkId: `ch${n}`,
      documentId: `d${n}`,
      fileName: n === 1 ? "RTUs_Approved.pdf" : "ARCHIVE_RTUs_Rejected.pdf",
      projectFolder: "221457_MAGNODE",
      path: "11 - SUBMITTALS/x.pdf",
      webUrl: n === 1 ? "https://sharepoint.example/x.pdf" : null,
      versionLabel: null,
      isLatest: n === 1,
      isArchived: n === 2,
      pageStart: 114,
      pageEnd: 115,
      section: null,
      sheet: null,
      cellRange: null,
      excerpt: "<b>APPROX. WEIGHT</b> 375 LBS",
    })),
    ...over,
  },
});

describe("AnswerCard", () => {
  it("links each citation to its source, tags the archived one, and lists bullet lines", () => {
    const html = renderToStaticMarkup(createElement(AnswerCard, { asked: asked() }));
    expect(html).toContain('href="#src-q1-1"');
    expect(html).toContain('id="src-q1-2"');
    expect(html).toContain("Archived</span>");
    expect(html).toContain("<li>Length 172.5 in");
    expect(html).toContain("Pages 114-115");
    expect(html).toContain("Ann A · Nov 10, 2026, 11:00 AM");
    // Passage text is text, never markup.
    expect(html).toContain("&lt;b&gt;APPROX. WEIGHT&lt;/b&gt;");
  });

  it("says when sources disagree and what the documents do not say", () => {
    const html = renderToStaticMarkup(
      createElement(AnswerCard, {
        asked: asked({ missing: "No shipping weight.", conflicts: [{ about: "operating weight", sources: [1, 2] }] }),
      }),
    );
    expect(html).toContain("Sources disagree on operating weight");
    expect(html).toContain("Not in the documents: </span>No shipping weight.");
  });
});

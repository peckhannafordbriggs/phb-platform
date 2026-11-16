import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnswerCard, projectPattern } from "@/app/(modules)/knowledge-base/answer-card";
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
  reportedByMe: false,
  answer: {
    version: 1,
    kind: "answered",
    text: "On Magnode, about 375 LBS [1]; the rejected submittal said 410 [2].\n- Length 172.5 in [1]",
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
    expect(html).toContain("RTUs_Approved.pdf</a><span class=\"text-[var(--muted)]\">, pages 114-115");
    expect(html).toContain("Ann A · Nov 10, 2026, 11:00 AM");
    // Only what helps: no raw folder name, no timing or passage count.
    expect(html).not.toContain("221457_MAGNODE");
    // The project is named on each source (old snapshots: from the folder) and highlighted in the answer.
    expect(html.match(/>221457 MAGNODE</g)).toHaveLength(2);
    expect(html).toMatch(/On <mark class="[^"]*">Magnode<\/mark>, about 375 LBS/);
    expect(html).not.toMatch(/Read \d+ passage|4\.2 s/);
    expect(html).toContain("Report a wrong answer");
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

  it("says the viewer already reported it instead of offering the button again", () => {
    const html = renderToStaticMarkup(createElement(AnswerCard, { asked: { ...asked(), reportedByMe: true } }));
    expect(html).toContain("Reported. A Knowledge Base admin will look at it.");
    expect(html).not.toContain("Report a wrong answer");
  });

  it("marks a project by its full label, its name or its job number, whole words only", () => {
    const pattern = projectPattern(["221457 MAGNODE", "224070 UC OLD CHEM"])!;
    const marked = (text: string) => text.split(pattern).filter((_, i) => i % 2 === 1);
    expect(marked("221457 MAGNODE and UC Old Chem (224070) differ")).toEqual(["221457 MAGNODE", "UC Old Chem", "224070"]);
    expect(marked("magnode")).toEqual(["magnode"]);
    expect(marked("MAGNODES 2214570")).toEqual([]);
    expect(projectPattern([])).toBeNull();
  });
});

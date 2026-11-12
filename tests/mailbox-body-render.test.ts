import { describe, expect, it } from "vitest";
import {
  INLINE_IMAGE_CSP_PATH,
  buildBodyDocument,
} from "@/app/(modules)/change-orders/build-body-document";
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

/** The origin the component reads from `location.origin` in the browser. */
const ORIGIN = "https://platform.example";

function render(
  html: string,
  allowRemoteImages = false,
  options: {
    origin?: string | null;
    resolveInlineImage?: (contentId: string) => string | null;
  } = {},
): string {
  const sanitized = sanitizeEmailHtml(html, {
    allowRemoteImages,
    resolveInlineImage: options.resolveInlineImage,
  });
  const body: MessageBody = {
    content: sanitized.html,
    format: "html",
    remoteImagesBlocked: sanitized.remoteImagesBlocked,
    inlineImages: sanitized.inlineImages,
    inlineImagesUnresolved: sanitized.inlineImagesUnresolved,
  };
  return buildBodyDocument(
    body,
    allowRemoteImages,
    options.origin === undefined ? ORIGIN : options.origin,
  );
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
    // The platform's own origin is https too, so look at the scheme source
    // itself rather than the substring.
    expect(csp).not.toMatch(/img-src[^;]*\bhttps:(?:\s|;|$)/);
  });

  it("permits https images only once a person asks", () => {
    expect(policy(render("<p>hi</p>", true))).toContain("img-src https: data:");
  });

  /**
   * `cid:` never reaches the document. An inline image the message carries is
   * rewritten to the platform's own signed link for the attachment, which the
   * CSP admits by naming the platform's origin and the message routes' path -
   * and nothing else of the platform's. One the message does not carry has its
   * src removed and is marked, so the stylesheet draws a labelled placeholder.
   */
  it("admits the platform's inline-image links by origin and path, and no cid:", () => {
    const link = `${INLINE_IMAGE_CSP_PATH}m1/inline-images/a1?exp=1&sig=abc`;
    const document = render('<img src="cid:logo123" alt="logo">', false, {
      resolveInlineImage: (id) => (id === "logo123" ? link : null),
    });

    expect(policy(document)).toContain(`img-src data: ${ORIGIN}${INLINE_IMAGE_CSP_PATH}`);
    expect(policy(document)).not.toContain("cid:");
    expect(policy(document)).not.toContain("'self'");
    // Serialised as markup, so the query's ampersand is an entity.
    expect(document).toContain(`src="${link.replace("&", "&amp;")}"`);
    expect(document).not.toContain("cid:logo123");
    // An ordinary image: not marked as a placeholder (the stylesheet always
    // carries the placeholder rule, so look at the element, not the document).
    expect(document).not.toContain('data-inline-image="true"');
  });

  it("marks an inline image the message does not carry as a placeholder", () => {
    const document = render('<img src="cid:logo123" alt="logo">');

    expect(document).not.toContain("cid:logo123");
    expect(document).toContain('data-inline-image="true"');
  });

  it("names no origin at all when the component has none to give", () => {
    const csp = policy(render("<p>hi</p>", false, { origin: null }));

    expect(csp).toContain("img-src data:;");
    expect(csp).not.toContain(INLINE_IMAGE_CSP_PATH);
  });

  it("refuses anything that is not a bare origin", () => {
    for (const bad of [
      "https://platform.example/",
      "https://platform.example/path",
      "javascript:alert(1)",
      "https://platform.example\" img-src *",
      "*",
    ]) {
      const csp = policy(render("<p>hi</p>", false, { origin: bad }));
      expect(csp, bad).toBe(policy(render("<p>hi</p>", false, { origin: null })));
    }
  });

  it("admits the platform's origin on a port, which is what development uses", () => {
    const csp = policy(render("<p>hi</p>", false, { origin: "http://localhost:3000" }));

    expect(csp).toContain(`http://localhost:3000${INLINE_IMAGE_CSP_PATH}`);
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
        inlineImagesUnresolved: 0,
      },
      false,
    );

    // A text/plain message containing "<script>" is text, and stays text.
    expect(document).toContain("&lt;script&gt;");
    expect(document.toLowerCase()).not.toContain("<script>");
  });

  it("preserve their line breaks", () => {
    const document = buildBodyDocument(
      {
        content: "line one\nline two",
        format: "text",
        remoteImagesBlocked: 0,
        inlineImages: 0,
        inlineImagesUnresolved: 0,
      },
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

/**
 * The hidden preheader the company's mail filter injects above every inbound
 * message, as it arrived in a real reply on 2026-11-12. With its hiding
 * declarations stripped and `max-width:0` kept, two hundred characters of
 * 1px white text wrapped one per line and opened the message on a blank
 * screen. The pane now keeps what hides it, exactly as Outlook does.
 */
describe("the phish-fence preheader", () => {
  const preheader =
    '<div style="display:none; font-size:1px; color:#ffffff!important; line-height:1px; ' +
    'max-height:0px; max-width:0px; opacity:0; overflow:hidden">From: changeorder ' +
    "&lt;changeorder@phb1899.com&gt; Sent: Thursday, November 5, 2026 8:40 AM</div>" +
    "<p>Hi Josh,</p>";

  it("stays hidden, so the message is not pushed off the first screen", () => {
    const document = render(preheader);
    const div = /<div style="([^"]*)">From/.exec(document)?.[1] ?? "";

    expect(div).toContain("display:none");
    expect(div).toContain("max-height:0px");
    expect(div).toContain("overflow:hidden");
    // Still no property that can name a URL or position anything.
    expect(div).not.toContain("opacity");
    expect(document).toContain("<p>Hi Josh,</p>");
  });
});

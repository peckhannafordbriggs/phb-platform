import sanitizeHtml from "sanitize-html";

/**
 * Vendor email bodies are attacker-controlled HTML.
 *
 * Anyone with the change-order mailbox address can put arbitrary markup in front
 * of a PH+B employee. This is the only function that turns such a body into
 * something renderable, and it is an allowlist: unknown tags, unknown
 * attributes and unknown CSS declarations are dropped, not inspected.
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
 *   class  - only useful with a stylesheet we are not going to allow.
 *   id     - lets remote content collide with our own DOM ids.
 *
 * Event handlers need no mention: an allowlist drops everything unnamed, so
 * onerror, onload and friends cannot survive by being forgotten here.
 *
 * `rel` and `target` on an anchor are written by the transform below and are
 * never carried over from the message - the transform overwrites whatever the
 * sender supplied.
 *
 * `style` IS allowed, but only as a carrier for the declarations named in
 * ALLOWED_STYLES. Every value there is matched against a pattern, and a
 * declaration that does not match is dropped rather than escaped. See that
 * table for why this is not the hole it looks like.
 */
const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  a: ["href", "title", "rel", "target"],
  img: ["alt", "src", "width", "height", "data-remote-blocked"],
  td: ["colspan", "rowspan", "align", "valign"],
  th: ["colspan", "rowspan", "align", "valign", "scope"],
  col: ["span", "width"],
  colgroup: ["span"],
  table: ["align", "border", "cellpadding", "cellspacing", "width"],
  "*": ["dir", "lang", "title", "style"],
};

/**
 * Inline CSS, restricted to the visual properties an email actually uses.
 *
 * Dropping style entirely was the earlier position, and it cost more than it
 * was worth: an automation body carries 12-28 style attributes and no other
 * styling, so the pane showed a plain white table where the recipient sees a
 * grey header row and Calibri 11pt. On the draft screen that is worse than
 * ugly - the pane is labelled "how the recipient sees it" and is the last
 * thing anyone looks at before sending.
 *
 * What made style dangerous is absent from this list rather than filtered out
 * of it:
 *
 *   - No property here takes a URL. `background-image`, `background` (whose
 *     shorthand accepts a url()), `list-style-image`, `cursor`, `content` and
 *     `filter` are all unlisted, so CSS cannot make a network request and
 *     cannot become the read-receipt channel that blocking remote images
 *     exists to close.
 *   - No property here positions anything. `position`, `top`, `left`,
 *     `z-index` and `transform` are unlisted, so message content cannot be laid
 *     over the platform own UI. The body renders in a sandboxed iframe, so
 *     today it has no UI of ours to cover; this keeps that true if the frame
 *     ever moves.
 *
 * The value patterns are the other half of it. Only the rgb()/rgba() forms
 * admit a parenthesis at all, and only over digits, dots, commas and spaces,
 * so `url(`, `expression(` and `image-set(` cannot be spelled by any accepted
 * value. A declaration that does not match is discarded, not corrected.
 */
const COLOR = [
  /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d{1,3})\s*)?\)$/i,
  // Named colours. Bounded and letters-only, so it cannot reach a function.
  /^[a-z]{3,20}$/i,
];

const ONE_LENGTH = '-?\\d{1,4}(?:\\.\\d{1,3})?(?:px|pt|em|rem|ex|pc|in|cm|mm|%)?|auto|0';

/** A single length, for the per-side properties. */
const LENGTH = [new RegExp(`^(?:${ONE_LENGTH})$`, "i")];

/** One to four lengths, as the padding and margin shorthands take. */
const LENGTHS = [
  new RegExp(`^(?:${ONE_LENGTH})(?:\\s+(?:${ONE_LENGTH})){0,3}$`, "i"),
];

const LINE_STYLE =
  "none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset";

const BORDER = [
  new RegExp(
    "^(?:\\d{1,3}(?:\\.\\d{1,2})?(?:px|pt|em|rem)?\\s+)?" +
      `(?:${LINE_STYLE})` +
      "(?:\\s+(?:#(?:[0-9a-f]{3}|[0-9a-f]{6})|rgba?\\([0-9.,\\s]{5,40}\\)|[a-z]{3,20}))?$",
    "i",
  ),
];

const ALLOWED_STYLES: Record<string, Record<string, RegExp[]>> = {
  "*": {
    color: COLOR,
    "background-color": COLOR,

    // Underscores are load-bearing: Outlook's own default stack is
    // `aptos,aptos_embeddedfont,aptos_msfontservice,calibri,...`, and rejecting
    // it dropped the font from every paragraph of a real draft.
    "font-family": [/^[-_a-z0-9 ,'"]{1,200}$/i],
    "font-size": LENGTH,
    "font-weight": [/^(?:normal|bold|bolder|lighter|[1-9]00)$/i],
    "font-style": [/^(?:normal|italic|oblique)$/i],
    "line-height": [/^(?:normal|\d{1,3}(?:\.\d{1,3})?(?:px|pt|em|rem|%)?)$/i],

    "text-align": [/^(?:left|right|center|justify|start|end)$/i],
    "text-decoration": [/^(?:none|underline|line-through|overline)$/i],
    "text-transform": [/^(?:none|uppercase|lowercase|capitalize)$/i],
    "vertical-align": [
      /^(?:baseline|top|middle|bottom|sub|super|text-top|text-bottom)$/i,
    ],
    "white-space": [/^(?:normal|nowrap|pre|pre-wrap|pre-line)$/i],
    // Outlook writes both on every body it generates. Neither fetches anything
    // nor positions anything; omitting them just made real drafts render wrong.
    direction: [/^(?:ltr|rtl)$/i],
    "box-sizing": [/^(?:content-box|border-box)$/i],

    border: BORDER,
    "border-top": BORDER,
    "border-right": BORDER,
    "border-bottom": BORDER,
    "border-left": BORDER,
    "border-color": COLOR,
    "border-style": [new RegExp(`^(?:${LINE_STYLE})$`, "i")],
    "border-width": LENGTHS,
    "border-collapse": [/^(?:collapse|separate)$/i],
    "border-spacing": LENGTHS,
    "border-radius": LENGTHS,

    padding: LENGTHS,
    "padding-top": LENGTH,
    "padding-right": LENGTH,
    "padding-bottom": LENGTH,
    "padding-left": LENGTH,
    margin: LENGTHS,
    "margin-top": LENGTH,
    "margin-right": LENGTH,
    "margin-bottom": LENGTH,
    "margin-left": LENGTH,

    width: LENGTH,
    "min-width": LENGTH,
    "max-width": LENGTH,
    height: LENGTH,
  },
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
    allowedStyles: ALLOWED_STYLES,
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

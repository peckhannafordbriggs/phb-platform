import sanitizeHtml from "sanitize-html";
import { contentIdReference } from "./inline-images";

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
  img: ["alt", "src", "width", "height", "data-remote-blocked", "data-inline-image"],
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
    "max-height": LENGTH,

    /**
     * The four below hide or clip content, and they are here because leaving
     * them out broke the layout of real mail rather than protected anything.
     *
     * The phish-fence banner the company's mail filter injects at the top of
     * every inbound message starts with a hidden "preheader" div -
     * `display:none; max-height:0; overflow:hidden; max-width:0; font-size:1px;
     * color:#fff` - holding about two hundred characters of From/Sent/To text.
     * With `display`, `max-height` and `overflow` dropped and `max-width` kept,
     * that text wrapped one character per 1px line and pushed the message a few
     * hundred pixels down the pane: a reply with no images at all opened on a
     * blank screen (2026-11-12). Outlook honours `display:none`; so does the
     * pane now.
     *
     * None of the four can name a URL or position an element, which is the
     * test the table is built on. `display` is a closed list of flow values,
     * never `contents` and nothing from the grid or flex families, and
     * `visibility` cannot be used to make an invisible link that still takes
     * a click. `opacity` is deliberately absent: a zero-opacity anchor is
     * exactly that.
     */
    display: [
      /^(?:none|block|inline|inline-block|table|table-row|table-cell|table-row-group|table-header-group|table-footer-group|list-item)$/i,
    ],
    visibility: [/^(?:visible|hidden|collapse)$/i],
    overflow: [/^(?:visible|hidden|clip|auto|scroll)$/i],
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
 * `data:` is inert in an <img> - a browser does not run script inside an SVG
 * loaded as an image - and it is how an inline logo survives without a fetch.
 *
 * `cid:` is listed so the parser does not treat it as a disallowed scheme and
 * discard the element. The transform below then replaces the src with the
 * platform's own link to the attachment, or removes it when no attachment
 * matches. See INLINE image handling in sanitizeEmailHtml.
 */
const SAFE_IMAGE_SCHEMES = ["cid", "data"];

export interface SanitizedBody {
  html: string;
  /**
   * How many images had a remote source removed. Drives an honest "this message
   * contains remote images" prompt rather than a silently altered message.
   */
  remoteImagesBlocked: number;
  /**
   * How many `cid:` images were found - inline images that are attachments on
   * this message rather than remote content. Resolved or not; the next field
   * says how many were not.
   */
  inlineImages: number;
  /**
   * How many of those named a Content-ID that no attachment on the message
   * carries. Each is left as a marked placeholder, and the count drives an
   * honest note beside it rather than an unexplained box.
   */
  inlineImagesUnresolved: number;
}

export interface SanitizeOptions {
  /**
   * Off by default. Remote images are read receipts: loading one tells the
   * sender the mail was opened, from which IP, and when.
   */
  allowRemoteImages?: boolean;
  /**
   * Turns the Content-ID a `cid:` src names into the platform's own URL for
   * that attachment, or null when the message carries no such attachment.
   *
   * Supplied by the mail service, which knows the message's attachments and
   * holds the signing key. The sanitizer never sees either: it hands over a
   * normalised id and writes back whatever it is given. Absent, every `cid:`
   * image is unresolved.
   */
  resolveInlineImage?: (contentId: string) => string | null;
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
  const resolveInlineImage = options.resolveInlineImage ?? (() => null);
  let remoteImagesBlocked = 0;
  let inlineImages = 0;
  let inlineImagesUnresolved = 0;

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
        if (src === undefined) return { tagName, attribs };

        /**
         * An inline image: an attachment on this very message.
         *
         * The Content-ID is handed to the service's resolver, which answers
         * with the platform's own signed link to the attachment - the only
         * same-origin URL the body document's CSP admits - or with null when
         * the message carries no attachment by that id. A resolved image is an
         * ordinary <img> from here on.
         *
         * An unresolved one has its src removed rather than kept. A browser
         * cannot load `cid:`, and the broken-image glyph it draws reads as
         * "this application is broken" rather than "this image is missing from
         * the message". Without a src the element renders as the marked
         * placeholder the stylesheet draws, with its alt text, and the count
         * drives an honest note beside it.
         */
        const contentId = contentIdReference(src);
        if (contentId !== null || /^cid:/i.test(src.trim())) {
          inlineImages += 1;

          const url = contentId === null ? null : resolveInlineImage(contentId);
          if (url !== null) {
            return { tagName, attribs: { ...attribs, src: url } };
          }

          inlineImagesUnresolved += 1;

          const withoutSrc = { ...attribs };
          delete withoutSrc.src;

          return {
            tagName,
            attribs: { ...withoutSrc, "data-inline-image": "true" },
          };
        }

        // Bytes already in the body. Nothing to fetch, nothing to consent to.
        if (/^data:/i.test(src.trim())) return { tagName, attribs };

        /**
         * Neither inline, nor embedded, nor remote: a relative path, or a
         * scheme nothing here recognises. Such a src could not have loaded in
         * any mail client - but a relative one WOULD resolve against the
         * platform's own address inside the pane, and the only same-origin
         * request a body may cause is one the service wrote for it. Removed,
         * and not counted as anything, because there is nothing to show.
         */
        if (!isRemoteHttpUrl(src)) {
          const withoutSrc = { ...attribs };
          delete withoutSrc.src;
          return { tagName, attribs: withoutSrc };
        }

        if (allowRemoteImages) return { tagName, attribs };

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

  return { html: clean, remoteImagesBlocked, inlineImages, inlineImagesUnresolved };
}

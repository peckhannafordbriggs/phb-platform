import type { MessageBody } from "@/lib/modules/change-orders/mail/types";

/**
 * Builds the document a message body is rendered into.
 *
 * Kept out of the component so it is a pure function of the body and one flag,
 * and can be tested against hostile input without a DOM. It is the second layer
 * of the defence described in docs/03 - the sanitizer is the first, and neither
 * is an alternative to the other.
 */

/**
 * The path under which the platform serves a message's inline images, as the
 * CSP below permits it: this prefix on the platform's own origin and nothing
 * else of ours. Held to the URL the service writes by a test.
 */
export const INLINE_IMAGE_CSP_PATH = "/api/modules/change-orders/messages/";

/** `scheme://host[:port]` and nothing after it - what `location.origin` is. */
const ORIGIN_SHAPE = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i;

/**
 * An allowlist of nothing, plus the few things a mail body legitimately needs.
 *
 * `img-src` is the only directive that changes with "show images". `data:` stays
 * permitted either way, because an inline logo is not a network request.
 *
 * `cid:` is not listed: the sanitizer never lets one reach the document. A
 * `cid:` image the message carries is rewritten to the platform's own signed
 * link for the attachment, and one it does not carry has its src removed. The
 * links are what the platform's own origin is listed for - and listed with the
 * message routes' path, so the only same-origin request a body can cause is one
 * the service wrote for it.
 *
 * The origin is passed in rather than written as `'self'`. The frame is
 * sandboxed without `allow-same-origin`, so its own origin is opaque and
 * `'self'` would name nothing; the component reads `location.origin` instead,
 * which is also why the links are relative - both of the platform's hostnames
 * answer, and a srcdoc document resolves a relative URL against its parent's.
 */
export function contentSecurityPolicy(
  allowRemoteImages: boolean,
  inlineImageOrigin: string | null = null,
): string {
  const imgSrc = [
    ...(allowRemoteImages ? ["https:"] : []),
    "data:",
    ...(inlineImageOrigin !== null && ORIGIN_SHAPE.test(inlineImageOrigin)
      ? [`${inlineImageOrigin}${INLINE_IMAGE_CSP_PATH}`]
      : []),
  ].join(" ");

  return [
    "default-src 'none'",
    `img-src ${imgSrc}`,
    // For the stylesheet below, and for the style attributes the sanitizer
    // allows through. <style> ELEMENTS are still discarded with their contents,
    // so no message CSS can carry a selector: what survives is a short list of
    // visual declarations, each scoped to the one element carrying it. None of
    // them can name a URL, so this directive does not reopen the network.
    "style-src 'unsafe-inline'",
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

const BODY_STYLES = `
  :root { color-scheme: light; }
  body {
    margin: 0;
    padding: 20px 24px;
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #1a1a1a;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  a { color: #1d4ed8; }
  img { max-width: 100%; height: auto; }
  /* A blocked remote image, or an inline one the message does not actually
     carry, would otherwise collapse to a broken-image glyph with no
     explanation of why it is missing. Both kinds have had their src removed by
     the sanitizer, so the browser attempts no load at all and draws this box
     with the alt text instead. An inline image the message DOES carry is an
     ordinary <img> and takes none of this. */
  img[data-remote-blocked], img[data-inline-image] {
    display: inline-block;
    min-width: 120px;
    min-height: 28px;
    border: 1px dashed #d4d4d8;
    border-radius: 3px;
    background: #fafafa;
  }
  table { border-collapse: collapse; max-width: 100%; }
  td, th { padding: 4px 8px; vertical-align: top; }
  blockquote {
    margin: 12px 0;
    padding-left: 12px;
    border-left: 3px solid #e4e4e7;
    color: #52525b;
  }
  pre { white-space: pre-wrap; word-break: break-word; }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * `inlineImageOrigin` is the platform's own origin as the browser sees it -
 * `location.origin` - and is what lets the body's inline images load; see
 * contentSecurityPolicy. Null (the server, a test without one) permits none.
 */
export function buildBodyDocument(
  body: MessageBody,
  allowRemoteImages: boolean,
  inlineImageOrigin: string | null = null,
): string {
  // A plain-text body is escaped and wrapped, never interpreted as markup. A
  // text/plain message containing "<script>" is text, and must stay text.
  const content =
    body.format === "html"
      ? body.content
      : `<pre>${escapeHtml(body.content)}</pre>`;

  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(allowRemoteImages, inlineImageOrigin)}">`,
    // Nothing in a mail body should be able to send a referrer anywhere.
    '<meta name="referrer" content="no-referrer">',
    `<style>${BODY_STYLES}</style>`,
    "</head><body>",
    content,
    "</body></html>",
  ].join("");
}

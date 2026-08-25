import { MailError } from "./errors";

/**
 * What may be attached, and what a filename is allowed to be.
 *
 * Pure functions, deliberately: every rule here is a decision about hostile
 * input, and a decision about hostile input that can only be exercised through a
 * live Graph call is a decision nobody tests. The service calls these before it
 * builds a request; the download route calls them before it writes a header.
 */

/**
 * Graph's own boundary between a simple upload and an upload session.
 * docs/03-exchange-and-graph.md: "simple upload under 3 MB; createUploadSession
 * above that."
 */
export const SIMPLE_UPLOAD_MAX_BYTES = 3 * 1024 * 1024;

/**
 * The largest attachment the platform will add.
 *
 * Exchange Online's own per-message ceiling is 25 MB for most tenants, and a
 * message that exceeds it is rejected at send time - after the human clicked
 * send, which is the worst moment to find out. Refusing here means the failure
 * happens while somebody is still looking at the file picker.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Each PUT in an upload session. Graph requires a multiple of 320 KiB. */
export const UPLOAD_CHUNK_BYTES = 320 * 1024 * 10;

/**
 * Extensions Exchange, Outlook or Windows will execute.
 *
 * Blocked by extension rather than only by content type, because the content
 * type is whatever the browser guessed and an attacker picks it. Outlook blocks
 * most of these on delivery anyway; the platform refuses to be the thing that
 * put one in a message to a vendor in the first place.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  "ade", "adp", "app", "appref-ms", "asp", "aspx", "bas", "bat", "cer", "chm",
  "cmd", "cnt", "com", "cpl", "crt", "csh", "der", "diagcab", "dll", "exe",
  "fxp", "gadget", "grp", "hlp", "hpj", "hta", "htc", "inf", "ins", "isp",
  "its", "jar", "jnlp", "js", "jse", "ksh", "lnk", "mad", "maf", "mag", "mam",
  "maq", "mar", "mas", "mat", "mau", "mav", "maw", "mcf", "mda", "mdb", "mde",
  "mdt", "mdw", "mdz", "msc", "msh", "msh1", "msh2", "mshxml", "msi", "msp",
  "mst", "msu", "ops", "osd", "pcd", "pif", "pl", "plg", "prf", "prg",
  "printerexport", "ps1", "ps1xml", "ps2", "ps2xml", "psc1", "psc2", "psd1",
  "psdm1", "pst", "py", "pyc", "pyo", "pyw", "pyz", "pyzw", "reg", "scf", "scr",
  "sct", "shb", "shs", "theme", "url", "vb", "vbe", "vbp", "vbs", "vhd", "vhdx",
  "vsmacros", "vsw", "webpnp", "website", "ws", "wsc", "wsf", "wsh", "xbap",
  "xll", "xnk",
]);

/** Content types that mean "a program", whatever the file happens to be called. */
const EXECUTABLE_CONTENT_TYPES = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-dosexec",
  "application/vnd.microsoft.portable-executable",
  "application/x-executable",
  "application/x-elf",
  "application/x-mach-binary",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-csh",
  "application/x-bat",
  "application/hta",
  "application/x-ms-shortcut",
  "application/java-archive",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
]);

/** Reserved on Windows whatever the extension. A file called `CON.pdf` is one. */
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** Long enough for any real document name, short enough that Exchange accepts it. */
const MAX_FILENAME_LENGTH = 200;

const FALLBACK_FILENAME = "attachment";

/**
 * Reduces an attachment name to a bare filename that cannot address a path.
 *
 * Everything before the last separator is discarded, and BOTH separators count:
 * the platform runs on Linux in Azure and on Windows locally, so treating a
 * backslash as an ordinary character would mean `..\..\etc\passwd` survived on
 * the box where it is a separator. Control characters go too, CR and LF
 * especially - the download route puts this value in a Content-Disposition
 * header, and a newline there is header injection rather than an odd filename.
 *
 * Never throws and never returns "". A name we cannot make sense of becomes
 * `attachment`, because refusing to show somebody their own file over its name
 * is worse than showing it under a dull one. `assertUploadAllowed` is the half
 * that refuses.
 */
export function safeAttachmentName(name: string | null | undefined): string {
  if (name === undefined || name === null) return FALLBACK_FILENAME;

  // Path separators first, so a name that is nothing but a path still yields a
  // base to work with.
  const base = name.split(/[/\\]/).pop() ?? "";

  const cleaned = base
    // Control characters, DEL included. CR and LF above all: this value ends up
    // in a Content-Disposition header, where a newline is header injection.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    // Reserved on Windows and meaningless in a header. Not an allowlist: a
    // filename may legitimately contain almost anything else.
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    // A trailing dot or space is silently dropped by Windows, which makes the
    // name the platform reports differ from the one that lands on disk.
    .replace(/[. ]+$/, "");

  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    return FALLBACK_FILENAME;
  }

  const dot = cleaned.lastIndexOf(".");
  const stem = (dot === -1 ? cleaned : cleaned.slice(0, dot)).toLowerCase();
  if (WINDOWS_RESERVED.has(stem)) return `_${cleaned}`;

  return cleaned.length > MAX_FILENAME_LENGTH
    ? truncateKeepingExtension(cleaned, MAX_FILENAME_LENGTH)
    : cleaned;
}

/** Truncating a filename must not eat the extension - that is what identifies it. */
function truncateKeepingExtension(name: string, limit: number): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || name.length - dot > 12) return name.slice(0, limit);

  const extension = name.slice(dot);
  return name.slice(0, Math.max(1, limit - extension.length)) + extension;
}

/**
 * Refuses an upload the platform will not put in a message.
 *
 * Refuses rather than sanitizes, and the difference matters: a name is cosmetic
 * and can be cleaned, but "this is a program" is a decision, and quietly
 * renaming `invoice.exe` to `invoice_exe` would attach it anyway.
 *
 * Every extension in the name is tested, not only the last one.
 * `invoice.pdf.exe` ends in `.exe`, and `invoice.exe.pdf` is the trick that
 * relies on Windows hiding known extensions - both are refused.
 */
export function assertUploadAllowed(upload: {
  name: string | null | undefined;
  contentType: string | null | undefined;
  sizeBytes: number;
}): { name: string; contentType: string } {
  const name = safeAttachmentName(upload.name);

  if (upload.sizeBytes <= 0) {
    throw new MailError("attachment_rejected", {
      detail: `Refused attachment "${name}": empty file.`,
    });
  }

  if (upload.sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new MailError("attachment_too_large", {
      detail:
        `Refused attachment "${name}": ${upload.sizeBytes} bytes exceeds the ` +
        `${MAX_ATTACHMENT_BYTES}-byte limit.`,
    });
  }

  for (const part of name.toLowerCase().split(".").slice(1)) {
    if (EXECUTABLE_EXTENSIONS.has(part)) {
      throw new MailError("attachment_rejected", {
        detail: `Refused attachment "${name}": .${part} is executable content.`,
      });
    }
  }

  // Only the media type. A charset or boundary parameter is not part of the
  // decision, and `application/x-sh; charset=utf-8` must not slip past.
  const declared = (upload.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (EXECUTABLE_CONTENT_TYPES.has(declared)) {
    throw new MailError("attachment_rejected", {
      detail: `Refused attachment "${name}": content type ${declared} is executable.`,
    });
  }

  return {
    name,
    // Graph requires one. An unknown type is the honest generic, not a guess.
    contentType: declared.length > 0 ? declared : "application/octet-stream",
  };
}

/**
 * The Content-Disposition value for a download.
 *
 * Always `attachment`, never `inline`: an HTML or SVG attachment rendered inline
 * would execute in the platform's own origin, which is the one thing the
 * sandboxed reading pane exists to prevent.
 *
 * Both spellings of the filename are emitted, per RFC 6266 - the ASCII fallback
 * for anything old, and `filename*` with the real UTF-8 name. The fallback is
 * reduced to ASCII rather than dropped, because a browser that ignores
 * `filename*` would otherwise save the file under the URL's last segment, which
 * is an opaque Exchange ID.
 */
export function contentDisposition(name: string): string {
  const safe = safeAttachmentName(name);

  const ascii = safe
    // Non-ASCII and control characters alike, for the plain `filename=` half.
    .replace(/[^\u0020-\u007e]/g, "_")
    .replace(/["\\]/g, "_");

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRFC5987(safe)}`;
}

function encodeRFC5987(value: string): string {
  return encodeURIComponent(value)
    // encodeURIComponent leaves these, and RFC 5987 does not permit them.
    .replace(/['()!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * A vendor controls the attachment's declared type and the browser trusts the
 * response header - so an attachment claiming to be `text/html` is served as
 * `application/octet-stream` instead. Downloading it is fine; being talked into
 * rendering it in the platform's origin is not.
 *
 * With `X-Content-Type-Options: nosniff` and the `attachment` disposition, that
 * is three independent reasons the browser will not run it.
 */
const RENDERABLE_TYPES =
  /^(text\/html|text\/xml|application\/xhtml|image\/svg|application\/xml)/i;

export function safeDownloadContentType(contentType: string | null): string {
  const declared = (contentType ?? "").split(";")[0]?.trim() ?? "";
  if (declared.length === 0) return "application/octet-stream";
  if (RENDERABLE_TYPES.test(declared)) return "application/octet-stream";
  return declared;
}

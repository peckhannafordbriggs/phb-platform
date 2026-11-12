import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INLINE_IMAGE_LINK_TTL_SECONDS,
  MESSAGE_ROUTES_PATH,
  contentIdReference,
  deriveInlineImageKey,
  inlineImageUrl,
  normaliseContentId,
  sniffImageType,
  verifyInlineImageLink,
} from "@/lib/modules/change-orders/mail/inline-images";
import { INLINE_IMAGE_CSP_PATH } from "@/app/(modules)/change-orders/build-body-document";
import type { ChangeOrderMailService } from "@/lib/modules/change-orders/mail/service";
import type { AttachmentDownload } from "@/lib/modules/change-orders/mail/types";

/**
 * The link an inline image is served through, and the route that honours it.
 *
 * The reading pane's sandboxed frame sends no session cookie (measured in
 * Chrome and Edge on 2026-11-12: `Sec-Fetch-Site: cross-site`, no cookie), so
 * the image route stands on a signature the grant-gated message route wrote.
 * What these tests hold: a link names one message and one attachment and
 * nothing else can be read with it; it expires; it is checked before anything
 * about the mailbox is said; and what the route serves is decided from bytes.
 */

const KEY = deriveInlineImageKey("test-only-secret-never-used-outside-vitest");
const OTHER_KEY = deriveInlineImageKey("a-different-secret");
const NOW = Date.UTC(2026, 10, 12, 15, 0, 0);

function parts(url: string) {
  const parsed = new URL(url, "http://localhost");
  const match = /\/messages\/([^/]+)\/inline-images\/([^/?]+)/.exec(parsed.pathname);
  return {
    messageId: decodeURIComponent(match?.[1] ?? ""),
    attachmentId: decodeURIComponent(match?.[2] ?? ""),
    exp: parsed.searchParams.get("exp"),
    sig: parsed.searchParams.get("sig"),
  };
}

describe("the signed link", () => {
  it("is relative, under the message routes, and carries an expiry and a signature", () => {
    const url = inlineImageUrl(KEY, "AAMk=/x", "att 1", NOW);

    expect(url.startsWith(`${MESSAGE_ROUTES_PATH}/AAMk%3D%2Fx/inline-images/att%201?exp=`)).toBe(true);
    expect(url).toMatch(/&sig=[A-Za-z0-9_-]{43}$/);
    expect(parts(url).exp).toBe(String(Math.floor(NOW / 1000) + INLINE_IMAGE_LINK_TTL_SECONDS));
  });

  it("is under the path the body document's CSP admits, and only that", () => {
    const url = inlineImageUrl(KEY, "m", "a", NOW);

    expect(url.startsWith(INLINE_IMAGE_CSP_PATH)).toBe(true);
    expect(`${MESSAGE_ROUTES_PATH}/`).toBe(INLINE_IMAGE_CSP_PATH);
  });

  it("verifies for the message and attachment it was written for, until it expires", () => {
    const link = parts(inlineImageUrl(KEY, "m1", "a1", NOW));

    expect(verifyInlineImageLink(KEY, link, NOW)).toBe("valid");
    expect(verifyInlineImageLink(KEY, link, NOW + (INLINE_IMAGE_LINK_TTL_SECONDS - 1) * 1000)).toBe("valid");
    expect(verifyInlineImageLink(KEY, link, NOW + (INLINE_IMAGE_LINK_TTL_SECONDS + 1) * 1000)).toBe("expired");
  });

  it("names one attachment of one message and nothing else", () => {
    const link = parts(inlineImageUrl(KEY, "m1", "a1", NOW));

    expect(verifyInlineImageLink(KEY, { ...link, attachmentId: "a2" }, NOW)).toBe("invalid");
    expect(verifyInlineImageLink(KEY, { ...link, messageId: "m2" }, NOW)).toBe("invalid");
    // Nor a later expiry than it was given.
    expect(verifyInlineImageLink(KEY, { ...link, exp: String(Number(link.exp) + 1) }, NOW)).toBe("invalid");
  });

  it("is worthless under any other key, and so is a forged link whatever expiry it claims", () => {
    const link = parts(inlineImageUrl(OTHER_KEY, "m1", "a1", NOW));

    expect(verifyInlineImageLink(KEY, link, NOW)).toBe("invalid");
    // A forgery is "invalid", never "expired": the signature is checked first.
    expect(verifyInlineImageLink(KEY, { ...link, exp: "1" }, NOW)).toBe("invalid");
  });

  it("refuses anything that is not the shape of a link", () => {
    const link = parts(inlineImageUrl(KEY, "m1", "a1", NOW));

    for (const candidate of [
      { ...link, sig: null },
      { ...link, exp: null },
      { ...link, exp: "" },
      { ...link, exp: "1e9" },
      { ...link, exp: "-1" },
      { ...link, sig: "" },
      { ...link, sig: `${link.sig}=` },
      { ...link, sig: `${link.sig?.slice(0, 42)}` },
      { ...link, sig: `${link.sig}${link.sig}` },
    ]) {
      expect(verifyInlineImageLink(KEY, candidate, NOW), JSON.stringify(candidate)).toBe("invalid");
    }
  });

  it("derives a key from the session secret that is not the secret", () => {
    expect(KEY.length).toBe(32);
    expect(KEY.equals(deriveInlineImageKey("test-only-secret-never-used-outside-vitest"))).toBe(true);
    expect(KEY.equals(OTHER_KEY)).toBe(false);
    expect(KEY.toString("utf8")).not.toContain("test-only");
  });
});

describe("Content-ID matching", () => {
  it("reduces both sides to the bare id", () => {
    expect(normaliseContentId("<image001.png@01DC>")).toBe("image001.png@01DC");
    expect(normaliseContentId("  image001.png@01DC  ")).toBe("image001.png@01DC");
    expect(normaliseContentId("%3Cimage001.png%4001DC%3E")).toBe("image001.png@01DC");
    expect(normaliseContentId("%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("reads only a cid: src", () => {
    expect(contentIdReference("cid:abc@x")).toBe("abc@x");
    expect(contentIdReference("  CID:<abc@x>  ")).toBe("abc@x");
    expect(contentIdReference("cid:")).toBeNull();
    expect(contentIdReference("cid:<>")).toBeNull();
    expect(contentIdReference("https://x.invalid/cid:abc")).toBeNull();
    expect(contentIdReference("data:image/png;base64,cid:abc")).toBeNull();
  });
});

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01]);
const GIF = Buffer.from("GIF89a\u0001\u0000\u0001\u0000\u0080\u0000\u0000", "latin1");
const WEBP = Buffer.from("RIFF$\u0000\u0000\u0000WEBPVP8 ", "latin1");
const BMP = Buffer.from("BM6\u0000\u0000\u0000\u0000\u0000\u0000\u00006\u0000", "latin1");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8");

describe("deciding what an attachment is from its bytes", () => {
  it("recognises the raster formats a mail client embeds", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(BMP)).toBe("image/bmp");
  });

  it("recognises nothing else - SVG, HTML, a PDF, or a declared type with other bytes", () => {
    expect(sniffImageType(SVG)).toBeNull();
    expect(sniffImageType(Buffer.from("<!doctype html><script>alert(1)</script>"))).toBeNull();
    expect(sniffImageType(Buffer.from("%PDF-1.7\n%âãÏÓ\n"))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
    expect(sniffImageType(PNG.subarray(0, 8))).toBeNull();
  });
});

/**
 * The route. The service module is mocked at its boundary so the real wrapper,
 * the real verification and the real response headers run over a fake
 * download; the route tests in mailbox-routes.test.ts cover the grant-gated
 * routes, and this one is deliberately not among them.
 */
let download: (messageId: string, attachmentId: string) => Promise<AttachmentDownload>;
let configured = true;

// The session is mocked the way every route test mocks it - and here the
// assertion is that it is never even asked for. The frame that loads these
// images cannot present one, which is the whole reason the link exists.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/modules/change-orders/mail/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/modules/change-orders/mail/service")>();
  return {
    ...actual,
    mailboxConnectionStatus: () =>
      configured
        ? { configured: true, mailbox: "test@example.invalid" }
        : { configured: false, missing: ["GRAPH_CLIENT_ID"] },
    mailService: () =>
      ({
        downloadAttachment: (messageId: string, attachmentId: string) =>
          download(messageId, attachmentId),
      }) as unknown as ChangeOrderMailService,
  };
});

// After the mock, so the route picks it up.
const { GET } = await import(
  "@/app/api/modules/change-orders/messages/[messageId]/inline-images/[attachmentId]/route"
);
const { inlineImageSigningKey } = await import("@/lib/modules/change-orders/mail/service");
const { auth } = await import("@/auth");

function call(url: string, messageId = "m1", attachmentId = "a1") {
  return GET(new Request(`http://localhost${url}`), {
    params: Promise.resolve({ messageId, attachmentId }),
  });
}

async function json(response: Response) {
  return (await response.json()) as { error?: { code: string; message: string } };
}

describe("the inline-image route", () => {
  beforeEach(() => {
    configured = true;
    download = async () => ({ name: "icon.png", contentType: "image/png", bytes: new Uint8Array(PNG) });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves a signed link's image inline, typed from its bytes, uncached", async () => {
    const url = inlineImageUrl(inlineImageSigningKey(), "m1", "a1");
    const response = await call(url);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
    // No session was consulted: the link is the whole of the authorization.
    expect(vi.mocked(auth)).not.toHaveBeenCalled();
  });

  it("asks the service for exactly the message and attachment the link names", async () => {
    const asked: string[] = [];
    download = async (messageId, attachmentId) => {
      asked.push(`${messageId}/${attachmentId}`);
      return { name: "icon.png", contentType: "image/png", bytes: new Uint8Array(PNG) };
    };

    await call(inlineImageUrl(inlineImageSigningKey(), "m1", "a1"));

    expect(asked).toEqual(["m1/a1"]);
  });

  it("refuses an SVG whatever it is declared as, because inline on our origin is where script would run", async () => {
    download = async () => ({ name: "logo.svg", contentType: "image/png", bytes: new Uint8Array(SVG) });

    const response = await call(inlineImageUrl(inlineImageSigningKey(), "m1", "a1"));

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toContain("image/");
    expect(await response.text()).not.toContain("alert(1)");
  });

  it("serves the type the bytes are, not the type that was declared", async () => {
    download = async () => ({ name: "x.bin", contentType: "application/octet-stream", bytes: new Uint8Array(JPEG) });

    const response = await call(inlineImageUrl(inlineImageSigningKey(), "m1", "a1"));

    expect(response.headers.get("content-type")).toBe("image/jpeg");
  });

  it("answers an unsigned request with 403, before saying anything about the mailbox", async () => {
    configured = false;
    const response = await call("/api/modules/change-orders/messages/m1/inline-images/a1");

    expect(response.status).toBe(403);
    expect((await json(response)).error?.code).toBe("inline_image_link_invalid");
  });

  it("answers a link for another attachment with 403", async () => {
    const url = inlineImageUrl(inlineImageSigningKey(), "m1", "a1");
    const response = await call(url, "m1", "a2");

    expect(response.status).toBe(403);
    expect((await json(response)).error?.code).toBe("inline_image_link_invalid");
  });

  it("tells an expired link apart from a forged one", async () => {
    const url = inlineImageUrl(
      inlineImageSigningKey(),
      "m1",
      "a1",
      Date.now() - (INLINE_IMAGE_LINK_TTL_SECONDS + 60) * 1000,
    );
    const response = await call(url);

    expect(response.status).toBe(403);
    expect((await json(response)).error?.code).toBe("inline_image_link_expired");
  });

  it("reports the mailbox as not configured in the module's usual shape, given a valid link", async () => {
    configured = false;
    const response = await call(inlineImageUrl(inlineImageSigningKey(), "m1", "a1"));

    expect((await json(response)).error?.code).toBe("mail_not_configured");
  });
});

/**
 * Every other mail route is behind the module grant through `withMailbox`.
 * This is the one that is not, and the source says so: a second route taking
 * a signed link instead of the session is a decision, not a convention to
 * drift into.
 */
describe("which routes stand on a signed link", () => {
  const root = path.resolve("app/api/modules/change-orders");

  function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return routeFiles(full);
      return entry === "route.ts" ? [full] : [];
    });
  }

  it("is exactly the inline-image route", () => {
    const onSignedLink = routeFiles(root)
      .filter((file) => readFileSync(file, "utf8").includes("withInlineImageLink("))
      .map((file) => path.relative(root, file).replace(/\\/g, "/"));

    expect(onSignedLink).toEqual([
      "messages/[messageId]/inline-images/[attachmentId]/route.ts",
    ]);
  });

  it("and that route never imports the session wrapper", () => {
    const source = readFileSync(
      path.join(root, "messages/[messageId]/inline-images/[attachmentId]/route.ts"),
      "utf8",
    );

    // The prose may name withMailbox - it explains why this route is not
    // behind it - but nothing may import or call it.
    expect(source).not.toMatch(/import[^;]*\bwithMailbox\b/);
    expect(source).not.toMatch(/\bwithMailbox\s*\(/);
    expect(source).toContain("sniffImageType(");
  });
});

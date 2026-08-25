import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ATTACHMENT_BYTES,
  SIMPLE_UPLOAD_MAX_BYTES,
  UPLOAD_CHUNK_BYTES,
  assertUploadAllowed,
  contentDisposition,
  safeAttachmentName,
  safeDownloadContentType,
} from "@/lib/modules/change-orders/mail/attachments";
import { createMailService } from "@/lib/modules/change-orders/mail/service";
import { createGraphStub, graphErrorResponse, jsonResponse } from "./graph-stub";

/**
 * Attachments: what may be attached, what a filename may be, and what the
 * service refuses.
 *
 * The filename rules are tested as pure functions on purpose. Every one of them
 * is a decision about hostile input - a vendor chooses the name and the content
 * type of anything arriving in this mailbox - and a decision about hostile input
 * that can only be reached through a live Graph call is a decision nobody
 * exercises.
 */

const ZZTEST_DRAFT = {
  id: "AAMkDraft",
  subject: "ZZTEST [ZZTEST PR-91] New CO logged",
  toRecipients: [{ emailAddress: { name: "Me", address: "me@phb1899.com" } }],
  ccRecipients: [],
  bccRecipients: [],
  body: { contentType: "html", content: "<p>original</p>" },
  isDraft: true,
  hasAttachments: true,
  changeKey: "CK-1",
  lastModifiedDateTime: "2026-08-25T12:00:00Z",
};

const REAL_DRAFT = {
  ...ZZTEST_DRAFT,
  subject: "[CCHMC RFI 229] New CO logged",
};
const SENT_MESSAGE = { ...ZZTEST_DRAFT, isDraft: false };

/** Two attachments, so "the other one survived" is a thing that can be asserted. */
const EXISTING = {
  value: [
    {
      id: "att-original",
      name: "CO-229 Scope.pdf",
      contentType: "application/pdf",
      size: 12_345,
      isInline: false,
    },
  ],
};

const BOTH = {
  value: [
    ...EXISTING.value,
    {
      id: "att-new",
      name: "markup.pdf",
      contentType: "application/pdf",
      size: 2_048,
      isInline: false,
    },
  ],
};

function silenceLogs(): void {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

beforeEach(() => {
  vi.unstubAllEnvs();
  process.env.PHB_ALLOW_SEND = "false";
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.env.PHB_ALLOW_SEND = "false";
});

describe("an attachment name cannot become a path", () => {
  it("keeps only the last segment, on both separators", () => {
    // Both, because the platform runs on Linux in Azure and Windows locally -
    // treating a backslash as an ordinary character would let it through on the
    // machine where it is a separator.
    expect(safeAttachmentName("../../etc/passwd")).toBe("passwd");
    expect(safeAttachmentName("..\\..\\Windows\\System32\\config")).toBe("config");
    expect(safeAttachmentName("/absolute/path/invoice.pdf")).toBe("invoice.pdf");
    expect(safeAttachmentName("C:\\Users\\me\\invoice.pdf")).toBe("invoice.pdf");
    expect(safeAttachmentName("folder/")).toBe("attachment");
  });

  it("refuses to produce a traversal fragment", () => {
    for (const hostile of [
      "..",
      ".",
      "../",
      "..\\",
      "....//....//etc/passwd",
    ]) {
      const safe = safeAttachmentName(hostile);
      expect(safe).not.toContain("/");
      expect(safe).not.toContain("\\");
      expect(safe).not.toBe("..");
      expect(safe.length).toBeGreaterThan(0);
    }
  });

  it("strips CR and LF, which in a header would be injection", () => {
    // This value ends up in Content-Disposition. A newline there is not an odd
    // filename, it is a second header the attacker wrote.
    const safe = safeAttachmentName(
      "invoice.pdf\r\nX-Injected: yes\r\nContent-Type: text/html",
    );

    expect(safe).not.toContain("\r");
    expect(safe).not.toContain("\n");
    expect(safe).not.toContain("X-Injected: yes\r");
  });

  it("strips control characters and NUL", () => {
    expect(safeAttachmentName("in\u0000voice.pdf")).toBe("invoice.pdf");
    expect(safeAttachmentName("in\u0007voice.pdf")).toBe("invoice.pdf");
    expect(safeAttachmentName("in\u007fvoice.pdf")).toBe("invoice.pdf");
  });

  it("neutralises names Windows reserves", () => {
    // `CON.pdf` is a device on Windows whatever the extension says.
    expect(safeAttachmentName("CON.pdf")).toBe("_CON.pdf");
    expect(safeAttachmentName("nul")).toBe("_nul");
    expect(safeAttachmentName("LPT1.txt")).toBe("_LPT1.txt");
    // An ordinary name that merely starts the same way is untouched.
    expect(safeAttachmentName("console-log.txt")).toBe("console-log.txt");
  });

  it("never returns an empty name", () => {
    expect(safeAttachmentName("")).toBe("attachment");
    expect(safeAttachmentName("   ")).toBe("attachment");
    expect(safeAttachmentName(null)).toBe("attachment");
    expect(safeAttachmentName(undefined)).toBe("attachment");
    expect(safeAttachmentName("...")).toBe("attachment");
  });

  it("keeps the extension when it has to truncate", () => {
    const long = `${"a".repeat(400)}.pdf`;
    const safe = safeAttachmentName(long);

    // The extension is what identifies the file; truncating it away would make
    // the download unopenable.
    expect(safe.endsWith(".pdf")).toBe(true);
    expect(safe.length).toBeLessThanOrEqual(200);
  });

  it("leaves an ordinary real-world name exactly as it is", () => {
    // Names from this mailbox. Spaces, brackets, ampersands and accents are all
    // legitimate; this is not an allowlist.
    for (const name of [
      "CO-229 Scope.pdf",
      "Bid Tracker (copy).xlsx",
      "P&G Reese's markup.pdf",
      "Änderung.docx",
      "RFI 187 — response.msg",
    ]) {
      expect(safeAttachmentName(name)).toBe(name);
    }
  });
});

describe("executable content is refused", () => {
  const bytes = 1024;

  it("refuses by extension", () => {
    for (const name of [
      "payload.exe",
      "payload.EXE",
      "script.ps1",
      "macro.vbs",
      "installer.msi",
      "shortcut.lnk",
      "archive.jar",
      "thing.bat",
      "thing.cmd",
      "thing.js",
      "thing.reg",
      "thing.scr",
    ]) {
      expect(
        () => assertUploadAllowed({ name, contentType: "application/pdf", sizeBytes: bytes }),
        `${name} must be refused`,
      ).toThrowError(
        expect.objectContaining({ kind: "attachment_rejected" }) as unknown as Error,
      );
    }
  });

  it("refuses a double extension, in either order", () => {
    // `invoice.pdf.exe` ends in .exe. `invoice.exe.pdf` is the trick that relies
    // on Windows hiding known extensions. Both are refused, because every
    // extension in the name is tested rather than only the last.
    for (const name of ["invoice.pdf.exe", "invoice.exe.pdf", "a.b.c.vbs.txt"]) {
      expect(
        () => assertUploadAllowed({ name, contentType: "application/pdf", sizeBytes: bytes }),
        `${name} must be refused`,
      ).toThrowError(
        expect.objectContaining({ kind: "attachment_rejected" }) as unknown as Error,
      );
    }
  });

  it("refuses by content type even when the name looks harmless", () => {
    for (const contentType of [
      "application/x-msdownload",
      "application/x-sh",
      "application/java-archive",
      "text/javascript",
      // A parameter must not let it slip past.
      "application/x-sh; charset=utf-8",
      "APPLICATION/X-MSDOWNLOAD",
    ]) {
      expect(
        () => assertUploadAllowed({ name: "notes.pdf", contentType, sizeBytes: bytes }),
        `${contentType} must be refused`,
      ).toThrowError(
        expect.objectContaining({ kind: "attachment_rejected" }) as unknown as Error,
      );
    }
  });

  it("refuses an empty file", () => {
    expect(() =>
      assertUploadAllowed({ name: "empty.pdf", contentType: "application/pdf", sizeBytes: 0 }),
    ).toThrowError(
      expect.objectContaining({ kind: "attachment_rejected" }) as unknown as Error,
    );
  });

  it("refuses anything over the limit", () => {
    expect(() =>
      assertUploadAllowed({
        name: "huge.pdf",
        contentType: "application/pdf",
        sizeBytes: MAX_ATTACHMENT_BYTES + 1,
      }),
    ).toThrowError(
      expect.objectContaining({ kind: "attachment_too_large" }) as unknown as Error,
    );

    // Exactly at the limit is allowed. An off-by-one here would refuse a
    // legitimate 25 MB drawing set.
    expect(() =>
      assertUploadAllowed({
        name: "exactly.pdf",
        contentType: "application/pdf",
        sizeBytes: MAX_ATTACHMENT_BYTES,
      }),
    ).not.toThrow();
  });

  it("accepts the documents this mailbox actually carries", () => {
    for (const [name, contentType] of [
      ["CO-229 Scope.pdf", "application/pdf"],
      ["Bid Tracker.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["response.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["photo.jpg", "image/jpeg"],
      ["markup.png", "image/png"],
      ["thread.msg", "application/vnd.ms-outlook"],
    ] as const) {
      expect(
        () => assertUploadAllowed({ name, contentType, sizeBytes: 4096 }),
        `${name} must be accepted`,
      ).not.toThrow();
    }
  });

  it("supplies a generic content type rather than guessing", () => {
    const result = assertUploadAllowed({
      name: "notes.pdf",
      contentType: "",
      sizeBytes: 100,
    });

    expect(result.contentType).toBe("application/octet-stream");
  });
});

describe("the download response cannot be talked into rendering", () => {
  it("always says attachment, never inline", () => {
    expect(contentDisposition("CO-229 Scope.pdf")).toMatch(/^attachment;/);
    expect(contentDisposition("page.html")).toMatch(/^attachment;/);
  });

  it("emits both filename spellings, and the ASCII one is safe", () => {
    const header = contentDisposition("Änderung — CO.pdf");

    // The RFC 5987 form carries the real name; the plain form is the fallback
    // for a browser that ignores it, and must not break the header.
    expect(header).toContain("filename*=UTF-8''");
    expect(header).toMatch(/filename="[\u0020-\u007e]*"/);
    expect(header).not.toContain("Änderung");
  });

  it("cannot be made to inject a header", () => {
    const header = contentDisposition('bad"\r\nX-Injected: yes.pdf');

    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
    // A quote inside the ASCII fallback would close it early.
    expect(header.match(/"/g)?.length).toBe(2);
  });

  it("downgrades renderable content types", () => {
    // A vendor chooses the declared type, and the browser trusts the response
    // header. HTML or SVG served as itself would execute in the platform's own
    // origin - the one thing the sandboxed reading pane exists to prevent.
    for (const hostile of [
      "text/html",
      "text/html; charset=utf-8",
      "image/svg+xml",
      "application/xhtml+xml",
      "text/xml",
    ]) {
      expect(safeDownloadContentType(hostile)).toBe("application/octet-stream");
    }
  });

  it("leaves an ordinary type alone", () => {
    expect(safeDownloadContentType("application/pdf")).toBe("application/pdf");
    expect(safeDownloadContentType("image/png")).toBe("image/png");
    expect(safeDownloadContentType(null)).toBe("application/octet-stream");
  });
});

describe("adding an attachment to a draft", () => {
  it("posts a fileAttachment and re-reads the list from Exchange", async () => {
    const stub = createGraphStub((request) => {
      if (request.method === "POST") return jsonResponse({ id: "att-new" });
      if (request.url.includes("/attachments")) return jsonResponse(BOTH);
      return jsonResponse(ZZTEST_DRAFT);
    });

    const attachments = await createMailService(stub.transport).addDraftAttachment(
      "AAMkDraft",
      {
        name: "markup.pdf",
        contentType: "application/pdf",
        bytes: new Uint8Array([1, 2, 3, 4]),
      },
    );

    const post = stub.requests.find((r) => r.method === "POST");
    expect(post?.url).toContain("/messages/AAMkDraft/attachments");

    const sent = JSON.parse(post?.body ?? "{}") as Record<string, unknown>;
    expect(sent["@odata.type"]).toBe("#microsoft.graph.fileAttachment");
    expect(sent.name).toBe("markup.pdf");
    expect(sent.contentBytes).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));

    /**
     * The existing attachment survived, and this is the assertion PHASE-8 asks
     * for. It is answered from Exchange's own list rather than from what we sent,
     * because the risk is not "did my file arrive" - it is that a draft the
     * automation created loses an attachment a downstream flow expects.
     */
    expect(attachments.map((a) => a.id)).toEqual(["att-original", "att-new"]);
  });

  it("never names the existing attachments in the request", async () => {
    const stub = createGraphStub((request) => {
      if (request.method === "POST") return jsonResponse({ id: "att-new" });
      if (request.url.includes("/attachments")) return jsonResponse(BOTH);
      return jsonResponse(ZZTEST_DRAFT);
    });

    await createMailService(stub.transport).addDraftAttachment("AAMkDraft", {
      name: "markup.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([1]),
    });

    // Adding a sibling, not replacing a set. If the payload ever mentioned the
    // collection, Exchange would be free to treat it as the whole collection.
    const post = stub.requests.find((r) => r.method === "POST");
    expect(post?.body).not.toContain("att-original");
    expect(post?.body).not.toContain("CO-229 Scope.pdf");
  });

  it("refuses a draft that is not a ZZTEST", async () => {
    silenceLogs();
    const stub = createGraphStub(() => jsonResponse(REAL_DRAFT));

    await expect(
      createMailService(stub.transport).addDraftAttachment("AAMkDraft", {
        name: "markup.pdf",
        contentType: "application/pdf",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toMatchObject({ kind: "write_not_allowed" });

    expect(stub.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("refuses to attach anything to a message already sent", async () => {
    silenceLogs();
    const stub = createGraphStub(() => jsonResponse(SENT_MESSAGE));

    await expect(
      createMailService(stub.transport).addDraftAttachment("AAMkDraft", {
        name: "markup.pdf",
        contentType: "application/pdf",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toMatchObject({ kind: "not_draft" });

    expect(stub.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("refuses executable content in the service, not only at the route", async () => {
    silenceLogs();
    const stub = createGraphStub(() => jsonResponse(ZZTEST_DRAFT));

    await expect(
      createMailService(stub.transport).addDraftAttachment("AAMkDraft", {
        name: "payload.exe",
        contentType: "application/pdf",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toMatchObject({ kind: "attachment_rejected" });

    // It read the draft to apply the fence, and then attached nothing.
    expect(stub.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("uses an upload session at or above 3 MB", async () => {
    const puts: { url: string; range: string | null }[] = [];

    const stub = createGraphStub((request) => {
      if (request.url.includes("createUploadSession")) {
        return jsonResponse({ uploadUrl: "https://upload.example.invalid/session/1" });
      }
      if (request.url.includes("/attachments")) return jsonResponse(BOTH);
      return jsonResponse(ZZTEST_DRAFT);
    });

    // The upload-session PUTs do not go through the Graph client - the URL is
    // pre-authenticated and Microsoft documents that no Authorization header
    // should be sent - so they are intercepted through the same fetchImpl.
    const realFetch = stub.transport.fetchImpl;
    stub.transport.fetchImpl = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.startsWith("https://upload.example.invalid")) {
        puts.push({
          url,
          range: new Headers(init?.headers as HeadersInit).get("content-range"),
        });
        return new Response(null, { status: 201 });
      }
      return realFetch!(input, init);
    };

    // Deliberately more than one chunk, so contiguity is something the test can
    // actually observe rather than assert about a single PUT.
    const bytes = new Uint8Array(UPLOAD_CHUNK_BYTES + 1024);
    await createMailService(stub.transport).addDraftAttachment("AAMkDraft", {
      name: "drawings.pdf",
      contentType: "application/pdf",
      bytes,
    });

    expect(
      stub.requests.some((r) => r.url.includes("createUploadSession")),
    ).toBe(true);
    expect(puts).toHaveLength(2);

    // Ranges are contiguous, in order, and the last one ends at the real total.
    expect(puts[0]?.range).toBe(`bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${bytes.byteLength}`);
    expect(puts[1]?.range).toBe(
      `bytes ${UPLOAD_CHUNK_BYTES}-${bytes.byteLength - 1}/${bytes.byteLength}`,
    );

    // The pre-authenticated URL, and nothing else. Microsoft documents that no
    // Authorization header belongs on these, which is why they do not go through
    // the Graph client at all.
    expect(puts.every((p) => p.url.includes("upload.example.invalid"))).toBe(true);
  });

  it("reports throttling during an upload without half-attaching anything", async () => {
    silenceLogs();

    const stub = createGraphStub((request) => {
      if (request.url.includes("createUploadSession")) {
        return jsonResponse({ uploadUrl: "https://upload.example.invalid/session/1" });
      }
      return jsonResponse(ZZTEST_DRAFT);
    });

    const realFetch = stub.transport.fetchImpl;
    stub.transport.fetchImpl = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.startsWith("https://upload.example.invalid")) {
        return new Response(null, { status: 429 });
      }
      return realFetch!(input, init);
    };

    // One of the failure modes PHASE-8 names. It must be a typed "the mailbox is
    // busy", not a crash and not a silent partial attachment.
    await expect(
      createMailService(stub.transport).addDraftAttachment("AAMkDraft", {
        name: "drawings.pdf",
        contentType: "application/pdf",
        bytes: new Uint8Array(SIMPLE_UPLOAD_MAX_BYTES + 2048),
      }),
    ).rejects.toMatchObject({ kind: "throttled" });
  });
});

describe("removing an attachment", () => {
  it("deletes exactly one and returns what is left", async () => {
    const stub = createGraphStub((request) => {
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      if (request.url.includes("/attachments")) return jsonResponse(EXISTING);
      return jsonResponse(ZZTEST_DRAFT);
    });

    const attachments = await createMailService(stub.transport).removeDraftAttachment(
      "AAMkDraft",
      "att-new",
    );

    const del = stub.requests.find((r) => r.method === "DELETE");
    expect(del?.url).toContain("/messages/AAMkDraft/attachments/att-new");

    // The others survived - asserted from Exchange's list, not from arithmetic.
    expect(attachments.map((a) => a.id)).toEqual(["att-original"]);
  });

  it("is refused on a message that has already been sent", async () => {
    silenceLogs();
    const stub = createGraphStub(() => jsonResponse(SENT_MESSAGE));

    // A sent message is the record of what actually went. Editing that record
    // would be falsifying it, so this is a refusal rather than a UI convenience.
    await expect(
      createMailService(stub.transport).removeDraftAttachment("AAMkDraft", "att-1"),
    ).rejects.toMatchObject({ kind: "not_permitted" });

    expect(stub.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("is refused on a draft that is not a ZZTEST", async () => {
    silenceLogs();
    const stub = createGraphStub(() => jsonResponse(REAL_DRAFT));

    await expect(
      createMailService(stub.transport).removeDraftAttachment("AAMkDraft", "att-1"),
    ).rejects.toMatchObject({ kind: "write_not_allowed" });

    expect(stub.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("reports an attachment somebody already removed as not_found", async () => {
    silenceLogs();

    const stub = createGraphStub((request) =>
      request.method === "DELETE"
        ? graphErrorResponse(404, "ErrorItemNotFound", "gone")
        : jsonResponse(ZZTEST_DRAFT),
    );

    await expect(
      createMailService(stub.transport).removeDraftAttachment("AAMkDraft", "att-1"),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("downloading an attachment", () => {
  it("reads metadata, then the bytes from /$value", async () => {
    const content = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

    const stub = createGraphStub((request) => {
      if (request.url.includes("/$value")) {
        return new Response(content, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return jsonResponse(EXISTING.value[0]);
    });

    const file = await createMailService(stub.transport).downloadAttachment(
      "AAMkDraft",
      "att-original",
    );

    expect(file.name).toBe("CO-229 Scope.pdf");
    expect(file.contentType).toBe("application/pdf");
    expect(Array.from(file.bytes)).toEqual(Array.from(content));

    // Metadata first, so size is known before bytes are pulled into memory -
    // and so `contentBytes` is never selected on a message read.
    expect(stub.requests[0]?.url).not.toContain("$value");
    expect(stub.requests[0]?.url).not.toContain("contentBytes");
  });

  it("uses the name Exchange holds, reduced to something safe", async () => {
    const stub = createGraphStub((request) => {
      if (request.url.includes("/$value")) {
        return new Response(new Uint8Array([1]), { status: 200 });
      }
      return jsonResponse({
        ...EXISTING.value[0],
        name: "../../etc/passwd\r\nX-Injected: yes",
      });
    });

    const file = await createMailService(stub.transport).downloadAttachment(
      "AAMkDraft",
      "att-original",
    );

    // A vendor chose that name. It never reaches a header or a path in that form.
    expect(file.name).not.toContain("/");
    expect(file.name).not.toContain("\r");
    expect(file.name).not.toContain("\n");
  });

  it("downgrades a renderable declared type", async () => {
    const stub = createGraphStub((request) => {
      if (request.url.includes("/$value")) {
        return new Response(new Uint8Array([1]), { status: 200 });
      }
      return jsonResponse({
        ...EXISTING.value[0],
        name: "payload.html",
        contentType: "text/html",
      });
    });

    const file = await createMailService(stub.transport).downloadAttachment(
      "AAMkDraft",
      "att-original",
    );

    expect(file.contentType).toBe("application/octet-stream");
  });

  it("names an item attachment so it can be opened", async () => {
    const stub = createGraphStub((request) => {
      if (request.url.includes("/$value")) {
        return new Response(new Uint8Array([1]), { status: 200 });
      }
      return jsonResponse({
        id: "att-item",
        name: "Forwarded thread",
        size: 4096,
        "@odata.type": "#microsoft.graph.itemAttachment",
      });
    });

    const file = await createMailService(stub.transport).downloadAttachment(
      "AAMkDraft",
      "att-item",
    );

    // A message forwarded as an attachment is a message, not a file - Exchange
    // gives it no extension, and .eml is what makes it openable.
    expect(file.name).toBe("Forwarded thread.eml");
    expect(file.contentType).toBe("message/rfc822");
  });

  it("refuses to pull an oversized attachment into memory", async () => {
    silenceLogs();

    const stub = createGraphStub(() =>
      jsonResponse({ ...EXISTING.value[0], size: MAX_ATTACHMENT_BYTES + 1 }),
    );

    await expect(
      createMailService(stub.transport).downloadAttachment("AAMkDraft", "att-original"),
    ).rejects.toMatchObject({ kind: "attachment_too_large" });

    // It refused after reading the size and before reading any content.
    expect(stub.requests.some((r) => r.url.includes("$value"))).toBe(false);
  });

  it("does not require the message to be a draft", async () => {
    // Downloading is a read. Every message in this mailbox may carry an
    // attachment somebody needs, sent ones included.
    const stub = createGraphStub((request) => {
      if (request.url.includes("/$value")) {
        return new Response(new Uint8Array([1]), { status: 200 });
      }
      return jsonResponse(EXISTING.value[0]);
    });

    await expect(
      createMailService(stub.transport).downloadAttachment("AAMkSent", "att-original"),
    ).resolves.toMatchObject({ name: "CO-229 Scope.pdf" });
  });
});

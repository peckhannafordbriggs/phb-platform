import { describe, expect, it } from "vitest";
import { attachmentDownloadUrl } from "@/app/(modules)/change-orders/draft-client";
import { formatSize } from "@/app/(modules)/change-orders/attachments";

/**
 * The browser side of the Phase 8 actions, where it is pure.
 *
 * One thing here genuinely has to be proved rather than eyeballed: an Exchange
 * immutable id is base64-ish and contains `=`, `+`, `/` and `_`. A download link
 * built by interpolating one into a path without encoding it produces a URL that
 * addresses a different route - and the failure mode is a 404 on some
 * attachments and not others, which is exactly the kind of bug that gets
 * misfiled as "Graph is flaky".
 */

/** The shape of a real immutable id, with the characters that cause trouble. */
const REAL_MESSAGE_ID =
  "AAMkADE0NjQyNmExLTYzMTEtNGYwYS04MjEwLWZmMDVhOWEwZTcyZQAuAAAAAAD-ULHKy84YR6fWzxmXWyeqAQAw0UboecHAQpVDzCJqvqKuAABIUtc3AAA=";

describe("the attachment download URL", () => {
  it("encodes an id that ends in =", () => {
    const url = attachmentDownloadUrl(REAL_MESSAGE_ID, "att-1");

    // The `=` must not survive as a literal: it would be read as the start of a
    // query string by anything parsing the path loosely.
    expect(url).toContain("%3D");
    expect(url).not.toContain("AAA=/");
  });

  it("encodes + and / inside an id", () => {
    const url = attachmentDownloadUrl("AAMk+id/with=chars", "att+1/2");

    // A raw `/` would add path segments and address a different route entirely.
    expect(url).toBe(
      "/api/modules/change-orders/messages/AAMk%2Bid%2Fwith%3Dchars/attachments/att%2B1%2F2",
    );
  });

  it("round-trips through the encoding the route will apply", () => {
    const url = attachmentDownloadUrl(REAL_MESSAGE_ID, "AAMk+att/1=");

    const [, messageSegment, , attachmentSegment] = url
      .replace("/api/modules/change-orders/messages/", "")
      .match(/^(.*)(\/attachments\/)(.*)$/) ?? [];

    // What the server will decode has to be exactly what we started with.
    expect(decodeURIComponent(messageSegment ?? "")).toBe(REAL_MESSAGE_ID);
    expect(decodeURIComponent(attachmentSegment ?? "")).toBe("AAMk+att/1=");
  });

  it("points at the messages route, not the drafts one", () => {
    // Downloading is a read and works on any message. Only add and remove are
    // under /drafts/, because only a draft can have its attachments changed.
    expect(attachmentDownloadUrl("id", "att")).toContain("/messages/");
    expect(attachmentDownloadUrl("id", "att")).not.toContain("/drafts/");
  });
});

describe("attachment sizes read as sizes", () => {
  it("does not report a 900-byte file as 0 MB", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(900)).toBe("900 B");
    expect(formatSize(1024)).toBe("1 KB");
    expect(formatSize(12_345)).toBe("12 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(25 * 1024 * 1024)).toBe("25.0 MB");
  });

  it("says nothing when Exchange reported no size", () => {
    // An empty string rather than "0 B": claiming a size we were not given would
    // be a worse answer than showing none.
    expect(formatSize(null)).toBe("");
  });
});

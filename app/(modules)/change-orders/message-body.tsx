"use client";

import { useMemo } from "react";
import type { MessageBody } from "@/lib/modules/change-orders/mail/types";
import { buildBodyDocument } from "./build-body-document";

/**
 * Renders a message body inside a sandboxed iframe.
 *
 * Vendor email is attacker-controlled. The service has already run it through
 * sanitize.ts, and this is the second layer, not an alternative to the first -
 * docs/03: "Sanitize server-side, render in a sandboxed iframe with CSP, block
 * remote images by default."
 *
 * Three independent things have to fail before script in a vendor email runs:
 *
 *   1. The sanitizer's tag and attribute allowlist drops script, event handlers,
 *      javascript: URLs and style.
 *   2. `sandbox` without `allow-scripts` means the iframe cannot execute script
 *      at all, whatever survived.
 *   3. The document's Content-Security-Policy blocks script and every network
 *      destination the markup could otherwise reach.
 *
 * `srcDoc` rather than a blob or data URL: the content stays inert markup that
 * never becomes a same-origin document, and there is no URL to leak or navigate
 * to.
 */
export function MessageBodyFrame({
  body,
  remoteImagesAllowed,
  onShowImages,
}: {
  body: MessageBody | null;
  remoteImagesAllowed: boolean;
  onShowImages: () => void;
}) {
  const srcDoc = useMemo(
    () => (body === null ? null : buildBodyDocument(body, remoteImagesAllowed)),
    [body, remoteImagesAllowed],
  );

  if (body === null || body.content.trim().length === 0) {
    return (
      <p className="px-6 py-6 text-sm italic text-[var(--muted)]">
        This message has no content.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {body.remoteImagesBlocked > 0 && !remoteImagesAllowed && (
        <div className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-6 py-2.5">
          <p className="text-sm text-amber-900">
            {body.remoteImagesBlocked === 1
              ? "1 remote image was blocked."
              : `${body.remoteImagesBlocked} remote images were blocked.`}{" "}
            Loading them tells the sender you opened this message.
          </p>
          <button
            type="button"
            onClick={onShowImages}
            className="rounded border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
          >
            Show images
          </button>
        </div>
      )}

      {/*
        Inline images are attachments on this message, not remote content, so
        there is nothing to consent to and no button - the honest statement is
        that they exist and are not shown. Every message in the real mailbox
        that has images has some of these, and before this said so they rendered
        as unexplained placeholders that read as a bug.
      */}
      {body.inlineImages > 0 && (
        <div className="border-b border-[var(--border)] bg-[var(--surface)] px-6 py-2 text-sm text-[var(--muted)]">
          {body.inlineImages === 1
            ? "1 inline image is part of this message and is not shown here yet."
            : `${body.inlineImages} inline images are part of this message and are not shown here yet.`}{" "}
          Open the message in Outlook to see them.
        </div>
      )}

      <iframe
        // No allow-scripts, no allow-same-origin, no allow-forms. allow-popups
        // (with escape) only so a link the sanitizer already hardened with
        // rel="noopener noreferrer nofollow" can still be opened deliberately -
        // the same thing clicking a link in Outlook does.
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc ?? ""}
        title="Message body"
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}

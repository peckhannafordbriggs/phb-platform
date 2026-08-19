"use client";

import { useState } from "react";
import type { BodySegment } from "@/lib/modules/change-orders/mail/body-text";
import type { MessageBody } from "@/lib/modules/change-orders/mail/types";
import { MessageBodyFrame } from "./message-body";

/**
 * The body half of the draft editor.
 *
 * Two panes, and the split is the security boundary rather than a layout
 * preference. The message renders on the left in the same sandboxed iframe the
 * reading pane uses - no scripts, restrictive CSP, remote images blocked. The
 * editable fields sit on the right, in the application's own DOM, and never
 * contain markup.
 *
 * That is what keeps both defence layers. Editing in place on the rendered
 * message would mean either trusting the sanitizer alone in our origin or
 * allowing scripts in the iframe, and this is the one screen where vendor HTML
 * meets a send button.
 *
 * The fields edit TEXT ONLY. Everything else in the body - the table, its style
 * attributes, the <style> block, Outlook's wrapper - is never re-emitted, so it
 * survives byte for byte. Structural changes go through the source escape hatch.
 */
export function BodyEditor({
  preview,
  segments,
  edits,
  note,
  disabled,
  onEditSegment,
  onNoteChange,
  onShowImages,
  remoteImagesAllowed,
}: {
  preview: MessageBody | null;
  segments: BodySegment[];
  edits: Record<string, string>;
  note: string;
  disabled: boolean;
  onEditSegment: (id: string, text: string) => void;
  onNoteChange: (text: string) => void;
  onShowImages: () => void;
  remoteImagesAllowed: boolean;
}) {
  const [showNote, setShowNote] = useState(false);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-[var(--border)]">
        <PaneLabel>
          Preview — how the recipient sees it
        </PaneLabel>
        <MessageBodyFrame
          body={preview}
          remoteImagesAllowed={remoteImagesAllowed}
          onShowImages={onShowImages}
        />
      </div>

      <div className="flex min-h-0 w-96 shrink-0 flex-col">
        <PaneLabel>Message text — edit here</PaneLabel>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {segments.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">
              This message has no editable text. Use the HTML source view to change
              it.
            </p>
          ) : (
            <ul className="space-y-3">
              {segments.map((segment) => {
                const value = edits[segment.id] ?? segment.text;
                const changed = value !== segment.text;

                return (
                  <li key={segment.id}>
                    <label className="block">
                      <span className="mb-1 flex items-center gap-2 text-xs text-[var(--muted)]">
                        {segment.context}
                        {changed && (
                          <span className="rounded bg-amber-100 px-1.5 text-[0.625rem] font-medium text-amber-900">
                            edited
                          </span>
                        )}
                      </span>
                      <textarea
                        value={value}
                        disabled={disabled}
                        rows={Math.min(6, Math.ceil(value.length / 46) || 1)}
                        onChange={(e) => onEditSegment(segment.id, e.target.value)}
                        className={
                          "w-full resize-y rounded border px-2 py-1.5 text-sm disabled:bg-[var(--surface)] " +
                          (changed
                            ? "border-amber-400 bg-amber-50"
                            : "border-[var(--border)]")
                        }
                      />
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-5 border-t border-[var(--border)] pt-4">
            {showNote || note.length > 0 ? (
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--muted)]">
                  Add a paragraph at the end
                </span>
                <textarea
                  value={note}
                  disabled={disabled}
                  rows={3}
                  onChange={(e) => onNoteChange(e.target.value)}
                  className="w-full resize-y rounded border border-[var(--border)] px-2 py-1.5 text-sm disabled:bg-[var(--surface)]"
                />
                <span className="mt-1 block text-xs text-[var(--muted)]">
                  Appended to the end of the message. Nothing above it is changed.
                </span>
              </label>
            ) : (
              <button
                type="button"
                disabled={disabled}
                onClick={() => setShowNote(true)}
                className="text-sm text-[var(--accent)] underline underline-offset-2 disabled:opacity-50"
              >
                Add a paragraph at the end
              </button>
            )}
          </div>
        </div>

        <p className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-xs text-[var(--muted)]">
          Editing text here leaves the message&rsquo;s formatting exactly as the
          automation produced it.
        </p>
      </div>
    </div>
  );
}

function PaneLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
      {children}
    </div>
  );
}

/**
 * The escape hatch, for the rare structural change - a new table row, a link,
 * formatting the text fields cannot express.
 *
 * A textarea, so raw markup is never parsed. Saving from here replaces the whole
 * body rather than splicing, which is exactly why it is not the default and says
 * so on screen.
 */
export function BodySourceEditor({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 py-3">
      <p className="mb-2 shrink-0 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        Editing the source replaces the whole message body. The text view above
        changes only the words and leaves everything else untouched — prefer it
        unless you need to change structure.
      </p>
      <textarea
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="min-h-0 w-full flex-1 resize-none rounded border border-[var(--border)] p-3 font-mono text-xs leading-relaxed disabled:bg-[var(--surface)]"
      />
    </div>
  );
}

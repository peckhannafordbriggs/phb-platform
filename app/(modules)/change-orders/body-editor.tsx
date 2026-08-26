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
  previewStale,
  segments,
  edits,
  note,
  disabled,
  onEditSegment,
  onNoteChange,
  onCommitNote,
  noteBusy,
  onShowImages,
  remoteImagesAllowed,
}: {
  preview: MessageBody | null;
  /** Edits are typed but not yet written back, so the preview is behind. */
  previewStale: boolean;
  segments: BodySegment[];
  edits: Record<string, string>;
  note: string;
  disabled: boolean;
  onEditSegment: (id: string, text: string) => void;
  onNoteChange: (text: string) => void;
  /**
   * Adds the typed paragraph to the message, once.
   *
   * Deliberate rather than autosaved, because an append is not idempotent.
   * Autosaving it turned one sentence typed with two pauses into three
   * paragraphs and emptied the box mid-sentence - see draft-editor.tsx.
   */
  onCommitNote: () => void;
  /** A save is in flight, so committing again would be a second append. */
  noteBusy: boolean;
  onShowImages: () => void;
  remoteImagesAllowed: boolean;
}) {
  /**
   * Open already when there is no text to edit.
   *
   * A draft composed from scratch has no segments, so the only way to write
   * anything in the text view is this field - and leaving it collapsed behind a
   * link makes an empty draft look like one that cannot be edited at all.
   */
  const [showNote, setShowNote] = useState(segments.length === 0);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-[var(--border)]">
        <PaneLabel>
          <span className="flex items-center gap-2">
            Preview — how the recipient sees it
            {/*
              The preview renders what Exchange stores, which for about a second
              after a keystroke is not yet what the fields show. Saying so beats
              a pane that silently disagrees with the text beside it - the
              reasonable reading of that is "my edit did not save".
            */}
            {previewStale && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[0.625rem] font-medium normal-case tracking-normal text-amber-900">
                updating…
              </span>
            )}
          </span>
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
            /**
             * Two different situations reach here, and the copy has to serve
             * both. A draft composed from scratch has a genuinely empty body -
             * this is the case "add a paragraph at the end" was built for, and
             * pointing a person at the HTML source view to write their first
             * sentence would be absurd. A body made only of markup - an image,
             * a table of nothing but formatting - is the other, and the source
             * view is the right answer there.
             *
             * So it names the ordinary path first and keeps the escape hatch as
             * an aside.
             */
            <p className="text-sm text-[var(--muted)]">
              There is no text in this message yet. Use{" "}
              <span className="font-medium">Add a paragraph at the end</span>{" "}
              below to write it, or the HTML source view for anything
              structural.
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
              <div>
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
                </label>

                {/*
                  An explicit button, because appending is not idempotent and
                  must not happen on a timer. Type the whole paragraph, pause as
                  long as you like, then add it - once. Until it is clicked the
                  text is only on screen, which is why the hint below says so.
                */}
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={disabled || noteBusy || note.trim().length === 0}
                    onClick={onCommitNote}
                    className="rounded border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface)] disabled:opacity-50"
                  >
                    {noteBusy ? "Adding…" : "Add this paragraph"}
                  </button>
                  <span className="text-xs text-[var(--muted)]">
                    {note.trim().length === 0
                      ? "Appended to the end. Nothing above it is changed."
                      : "Not added yet — it goes in when you click, or when you send."}
                  </span>
                </div>
              </div>
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

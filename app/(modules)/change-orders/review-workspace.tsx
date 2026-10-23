"use client";

import { useCallback, useEffect, useState } from "react";
import type { MailAddress } from "@/lib/modules/change-orders/mail/types";
import {
  fileNameHint,
  type ReviewGroup,
  type ReviewNote,
} from "@/lib/modules/change-orders/review/notes";
import { AttachmentList } from "./attachments";
import {
  ApiError,
  describeUnexpected,
  fetchMessage,
  isMissing,
  type MessageResult,
} from "./mailbox-client";
import { MessageBodyFrame } from "./message-body";
import {
  REVIEW_NOT_CONFIGURED,
  fetchReviewListing,
  fetchReviewNote,
  type MailboxMatch,
  type ReviewListingResult,
  type ReviewNoteResult,
} from "./review-client";
import { MessageListSkeleton, PaneMessage, ReadingPaneSkeleton } from "./states";

/**
 * The Needs Review tab: the notes in `_needs_review`, grouped by subject, and
 * for the selected note its text beside the email it is about.
 *
 * READ-ONLY. There is no button here that resolves, dismisses, moves or
 * deletes anything, and the API it calls has no such route. A handled item
 * is still moved to `_archive/` by a person in SharePoint, as the routine in
 * docs/13-needs-review.md says; this screen notices on its next poll.
 *
 * Two sources, two paths. The NOTE is model-written plain text from
 * SharePoint, rendered as text - React escapes every string below, nothing
 * is interpolated as markup, and nothing in this file sets inner HTML from a
 * string (tests/co-review-ui.test.tsx renders a hostile note to prove it). The
 * EMAIL is the mailbox's own message, fetched through the mailbox's message
 * route and shown in the same sandboxed pane with the same attachment links
 * as the Mailbox tab, so the sanitizer and the streaming route are not
 * reimplemented here. The reading pane stays quiet: the note's own words,
 * then the vendor's own email, and no chrome competing with either.
 */

/** Re-read the folder this often while the tab is visible. See co-shell.tsx. */
const LIST_POLL_MS = 20_000;

type ListError = { code: string; message: string };

function errorOf(error: unknown, what: string): ListError {
  if (error instanceof ApiError) return { code: error.code, message: error.message };
  return { code: "unexpected", message: describeUnexpected(error, what) };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function ReviewWorkspace() {
  const [listing, setListing] = useState<ReviewListingResult | null>(null);
  const [listError, setListError] = useState<ListError | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewNoteResult | null>(null);
  const [detailError, setDetailError] = useState<ListError | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [message, setMessage] = useState<MessageResult | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [messageLoading, setMessageLoading] = useState(false);
  const [remoteImagesAllowed, setRemoteImagesAllowed] = useState(false);

  // The folder listing, on mount and on a poll while visible.
  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;

    const load = async () => {
      if (document.visibilityState !== "visible") return;
      controller?.abort();
      controller = new AbortController();
      try {
        const result = await fetchReviewListing(controller.signal);
        if (cancelled) return;
        setListing(result);
        setListError(null);
      } catch (error) {
        if (isAbort(error) || cancelled) return;
        setListError(errorOf(error, "listing the review folder"));
      }
    };

    void load();
    const timer = setInterval(() => void load(), LIST_POLL_MS);
    const onVisible = () => void load();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // The selected note, read fresh from the folder.
  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    setMessage(null);
    setMessageError(null);
    setRemoteImagesAllowed(false);
    if (selectedId === null) return;

    const controller = new AbortController();
    setDetailLoading(true);

    fetchReviewNote(selectedId, controller.signal)
      .then((result) => {
        setDetail(result);
        setDetailLoading(false);
      })
      .catch((error: unknown) => {
        if (isAbort(error)) return;
        setDetailError(errorOf(error, "reading the note"));
        setDetailLoading(false);
      });

    return () => controller.abort();
  }, [selectedId]);

  // The matched email, through the mailbox's own message route.
  const matched = detail?.mailbox.status === "matched" ? detail.mailbox.message.id : null;
  useEffect(() => {
    setMessage(null);
    setMessageError(null);
    if (matched === null) return;

    const controller = new AbortController();
    setMessageLoading(true);

    fetchMessage(matched, { allowRemoteImages: remoteImagesAllowed }, controller.signal)
      .then((result) => {
        setMessage(result);
        setMessageLoading(false);
      })
      .catch((error: unknown) => {
        if (isAbort(error)) return;
        setMessageError(
          isMissing(error)
            ? "That message is no longer in the mailbox."
            : errorOf(error, "reading the matched message").message,
        );
        setMessageLoading(false);
      });

    return () => controller.abort();
  }, [matched, remoteImagesAllowed]);

  const select = useCallback((id: string) => setSelectedId(id), []);

  const selectedListed =
    selectedId === null ||
    listing === null ||
    listing.groups.some((group) => group.notes.some((note) => note.id === selectedId));

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-[var(--radius-pane)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-soft)]">
      <section
        aria-label="Review notes"
        className="flex w-[24rem] shrink-0 flex-col border-r border-[var(--border)]"
      >
        {listing !== null && listError === null ? (
          <NoteList listing={listing} selectedId={selectedId} onSelect={select} />
        ) : listError !== null ? (
          <ListState error={listError} />
        ) : (
          <MessageListSkeleton />
        )}
      </section>

      <section aria-label="Review note" className="flex min-w-0 flex-1 flex-col overflow-auto">
        {selectedId === null ? (
          <PaneMessage
            calm
            title="Select a note"
            detail="Each note says why the automation stopped and what it suggests. The email it is about is shown beneath it."
          />
        ) : !selectedListed ? (
          <PaneMessage
            title="This note has left the folder"
            detail="It was moved or removed in SharePoint since the list was last read. Select another."
          />
        ) : detailLoading ? (
          <ReadingPaneSkeleton />
        ) : detailError !== null ? (
          <PaneMessage tone="error" title="The note could not be read" detail={detailError.message} />
        ) : detail !== null ? (
          <>
            <NoteView note={detail.note} />
            <MatchedMessageView
              match={detail.mailbox}
              message={message}
              loading={messageLoading}
              error={messageError}
              remoteImagesAllowed={remoteImagesAllowed}
              onShowImages={() => setRemoteImagesAllowed(true)}
            />
          </>
        ) : null}
      </section>
    </div>
  );
}

/**
 * The list pane's non-list states. "Not configured" is a state and not a
 * failure: the folder grant is IT's to make, and until it lands the folder is
 * still where it always was.
 */
function ListState({ error }: { error: ListError }) {
  if (error.code === REVIEW_NOT_CONFIGURED) {
    return (
      <PaneMessage
        title="Needs Review is not connected yet"
        detail="The platform has not been granted access to the _needs_review folder. Until it is, the folder is still readable in SharePoint, and nothing about the automation changes."
      />
    );
  }
  return <PaneMessage tone="error" title="The review folder could not be read" detail={error.message} />;
}

function NoteList({
  listing,
  selectedId,
  onSelect,
}: {
  listing: ReviewListingResult;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { summary, groups } = listing;

  return (
    <>
      <div className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <p className="text-sm font-medium">
          {summary.count === 0
            ? "Nothing needs review"
            : summary.count === 1
              ? "1 note needs review"
              : `${summary.count} notes need review`}
        </p>
        {summary.oldestDate !== null && (
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            Oldest from {summary.oldestDate}
            {groups.length > 1 ? ` · ${groups.length} subjects` : ""}
          </p>
        )}
      </div>

      {summary.count === 0 ? (
        <PaneMessage
          calm
          title="The folder is empty"
          detail="No note is waiting in _needs_review. New ones appear here within a minute of the classifier writing them."
        />
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto py-1" aria-label="Notes by subject">
          {groups.map((group) => (
            <GroupRows key={group.key} group={group} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </>
  );
}

function GroupRows({
  group,
  selectedId,
  onSelect,
}: {
  group: ReviewGroup;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <li className="px-2 pb-2">
      <div className="flex items-baseline justify-between gap-3 px-2 pb-1 pt-2">
        <p className="min-w-0 truncate text-sm font-medium" title={group.subject}>
          {group.subject}
        </p>
        <p className="shrink-0 text-xs text-[var(--muted)]">
          {group.notes.length === 1 ? "1 note" : `${group.notes.length} notes`}
        </p>
      </div>
      <ul>
        {group.notes.map((note) => {
          const active = note.id === selectedId;
          return (
            <li key={note.id}>
              <button
                type="button"
                onClick={() => onSelect(note.id)}
                aria-current={active ? "true" : undefined}
                className={
                  "block w-full rounded-[var(--radius-row)] px-3.5 py-2.5 text-left transition-colors " +
                  (active
                    ? "bg-[var(--neutral-100)]"
                    : "hover:bg-[var(--neutral-50)]")
                }
              >
                <div className="flex items-baseline justify-between gap-3 text-xs text-[var(--muted)]">
                  <span className="min-w-0 truncate">{describeFrom(note)}</span>
                  <span className="shrink-0 font-mono tabular-nums">{formatStamp(note)}</span>
                </div>
                <p className="mt-0.5 truncate text-sm" title={note.reason ?? undefined}>
                  {note.reason ?? "Needs review"}
                </p>
              </button>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

/**
 * The note, as text.
 *
 * Exported so a test can render it with a hostile note and read the markup.
 * Every value is a JSX text child; nothing here builds HTML from the note.
 */
export function NoteView({ note }: { note: ReviewNote }) {
  const parsed = note.why !== null || note.wrote !== null || note.nextStep !== null;

  return (
    <article className="border-b border-[var(--border)] px-6 py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
        {note.reason ?? "Needs review"}
      </p>
      <h2 className="mt-1 text-base font-semibold" title={note.subject ?? undefined}>
        {note.subject ?? fileNameHint(note.itemId)}
      </h2>

      <dl className="mt-3 space-y-1 text-sm">
        <Row label="Received">{note.receivedDate ?? formatStamp(note) ?? "Not stated"}</Row>
        <Row label="From">{describeFrom(note)}</Row>
        {note.classification !== null && (
          <Row label="Read as">
            {note.classification}
            {note.confidence !== null ? ` (${note.confidence} confidence)` : ""}
          </Row>
        )}
        <Row label="Item">{note.itemId}</Row>
      </dl>

      <div className="mt-4 space-y-4">
        <Section heading="Why this needs a human" text={note.why} />
        <Section heading="What they wrote" text={note.wrote} />
        <Section heading="Suggested next step" text={note.nextStep} />
      </div>

      {!parsed && (
        <p className="mt-4 text-sm text-[var(--muted)]">
          This note does not follow the usual layout, so its sections could not be picked out. The whole note is below.
        </p>
      )}

      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-[var(--muted)]">The whole note, as written</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words rounded-[var(--radius-row)] bg-[var(--surface)] p-3 font-mono text-xs">
          {note.text}
        </pre>
      </details>

      <p className="mt-3 text-xs text-[var(--muted)]">
        {note.hasItemFolder
          ? "An item folder with the automation's copy of the email sits beside this note in SharePoint."
          : "No item folder sits beside this note in SharePoint; the email is read from the mailbox below."}
        {note.webUrl !== null && (
          <>
            {" "}
            <a
              href={note.webUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-[var(--foreground)]"
            >
              Open in SharePoint
            </a>
          </>
        )}
      </p>
    </article>
  );
}

function Section({ heading, text }: { heading: string; text: string | null }) {
  return (
    <section>
      <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">{heading}</h3>
      {text === null ? (
        <p className="mt-1 text-sm italic text-[var(--muted)]">Not stated in the note.</p>
      ) : (
        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{text}</p>
      )}
    </section>
  );
}

/**
 * The email behind the note, from the mailbox, in the mailbox's own pane.
 *
 * The match is stated for what it is - the message with this subject nearest
 * the note's time that day - and the message's own sender and time are shown
 * so a wrong pairing is visible.
 */
function MatchedMessageView({
  match,
  message,
  loading,
  error,
  remoteImagesAllowed,
  onShowImages,
}: {
  match: MailboxMatch;
  message: MessageResult | null;
  loading: boolean;
  error: string | null;
  remoteImagesAllowed: boolean;
  onShowImages: () => void;
}) {
  if (match.status === "unavailable") {
    return (
      <Aside>
        The mailbox could not be searched for this note&apos;s email. The note above stands on its own.
      </Aside>
    );
  }

  if (match.status === "none") {
    return (
      <Aside>
        No message with this subject was found in the mailbox
        {match.day !== null ? ` around ${match.day}` : ""}. The note quotes what was written.
      </Aside>
    );
  }

  return (
    <div className="flex min-h-[36rem] flex-col">
      <div className="shrink-0 border-b border-[var(--border)] px-6 py-3 text-xs text-[var(--muted)]">
        The email, from the mailbox.{" "}
        {match.matchedBy === "message_id_and_time"
          ? "Matched by the message id in the note's name and the note's time"
          : "Matched by subject and the note's time"}
        {match.candidates > 1
          ? `: ${match.candidates} messages with this subject arrived that day, and the last one received before the note was written is shown.`
          : "."}
      </div>

      {loading ? (
        <ReadingPaneSkeleton />
      ) : error !== null ? (
        <PaneMessage tone="error" title="The email could not be read" detail={error} />
      ) : message !== null ? (
        <>
          <div className="shrink-0 border-b border-[var(--border)] px-6 py-4">
            <h2 className="text-base font-semibold" title={message.message.subject ?? undefined}>
              {message.message.subject ?? "(no subject)"}
            </h2>
            <dl className="mt-3 space-y-1 text-sm">
              <AddressRow label="From" addresses={message.message.from === null ? [] : [message.message.from]} />
              <AddressRow label="To" addresses={message.message.to} />
              <AddressRow label="Cc" addresses={message.message.cc} />
              <Row label="Date">
                {formatDateTime(message.message.sentDateTime ?? message.message.receivedDateTime)}
              </Row>
            </dl>
            <AttachmentList messageId={message.message.id} attachments={message.attachments} />
          </div>
          <MessageBodyFrame
            body={message.message.body}
            remoteImagesAllowed={remoteImagesAllowed}
            onShowImages={onShowImages}
          />
        </>
      ) : null}
    </div>
  );
}

function Aside({ children }: { children: React.ReactNode }) {
  return <p className="px-6 py-4 text-sm text-[var(--muted)]">{children}</p>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-xs text-[var(--muted)]">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}

function AddressRow({ label, addresses }: { label: string; addresses: MailAddress[] }) {
  if (addresses.length === 0) return null;
  return <Row label={label}>{addresses.map((a) => a.name ?? a.address).join(", ")}</Row>;
}

function describeFrom(note: ReviewNote): string {
  if (note.from === null) return "Sender not stated";
  if (note.from.name !== null && note.from.address !== null) {
    return `${note.from.name} <${note.from.address}>`;
  }
  return note.from.name ?? note.from.address ?? "Sender not stated";
}

/** The filename's stamp: `2026-10-05 11:01 UTC`, or the date alone, or nothing. */
function formatStamp(note: Pick<ReviewNote, "fileDate" | "fileTime">): string | null {
  if (note.fileDate === null) return null;
  return note.fileTime === null
    ? note.fileDate
    : `${note.fileDate} ${note.fileTime.slice(0, 5)} UTC`;
}

function formatDateTime(value: string | null): string {
  if (value === null) return "Unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

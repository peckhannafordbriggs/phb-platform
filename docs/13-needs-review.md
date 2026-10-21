# `_needs_review` — what it is and how to work it

**Written 2026-10-21.** Plain-language reference for anyone operating the CO Response pipeline.
No technical background assumed.

---

## 1. The one-paragraph version

When a reply arrives at `changeorder@`, an automated classifier reads it and tries to work out
which change order it belongs to and what kind of reply it is. Most of the time it succeeds and the
pipeline carries on by itself. When it **can't** work it out confidently, it is designed to stop
rather than guess. Those stopped items go to a folder called `_needs_review`, along with a plain
English note explaining what it couldn't resolve and what a person should do. **`_needs_review` is
the pipeline's "I need a human" tray.**

---

## 2. Where to find it

SharePoint → **AI Sandbox** site → Shared Documents → CO Managment Process → Change Order Step 2 →
**`_needs_review`**

```
https://peckhannafordbriggs.sharepoint.com/sites/AISandbox/Shared%20Documents/CO%20Managment%20Process/Change%20Order%20Step%202/_needs_review
```

It is a normal SharePoint folder. Anyone with access to the site can open it in a browser.

> **It is not in Outlook.** Nothing about a review item ever reaches the mailbox — no email, no
> draft, no alert, no flag. If nobody opens this folder, nobody knows anything is waiting. See §8.

---

## 3. What you will find in there

Two kinds of thing.

**a) A note, for every flagged item.** A plain text file named:

```
NEEDS REVIEW - 2026-10-05 110119 - RE RFI 254 - CCHMC Liberty [MN2PR19M].txt
```

**b) The email itself, as a folder.** Named after the same email, containing `body.txt` (the message
text), any attachments, and two machine files (`classify_request.json`, `classification_result.json`)
that you can ignore.

Before 2026-10-21 only the note arrived — the email folder stayed stuck in `_to_classify`. That was
the bug fixed on that date (§7). From now on both land together.

---

## 4. What a note looks like

Real example, in full:

```
NEEDS REVIEW — unmatched Change Order reply
============================================
Received: 2026-10-05
From:     Mark Shad <mshad@phb1899.com>
Subject:  RE: RFI 254 - CCHMC Liberty

WHY THIS NEEDS A HUMAN
The email is about CCHMC RFI 254, but there is no CCHMC|RFI 254 row in the Bid Tracker and the
thread's conversation ID matches no tracked CO. It looks like an internal discussion on Josh's
original RFI 254 request to changeorder@, not a vendor reply, so the agent did not attach it to
any CO.

WHAT THEY WROTE
"Do we only put flex connections in where noted? There are many other ducts crossing the line,
and they are not noted."

SUGGESTED NEXT STEP
Confirm whether RFI 254 has gone through intake / Gate B. If it has a CO row (or should),
re-stage with co_key CCHMC|RFI 254 so the Q&A can be logged; otherwise treat as internal
discussion and close.

Classification: question (high confidence)   ·   Item: 2026-10-05 110119 - RE RFI 254 ...
Source: Change Order Step 2/_to_classify/2026-10-05 110119 - RE RFI 254 ...
```

Every note has the same four parts:

| Section | What it tells you |
|---|---|
| **Header** | Date received, who sent it, subject line |
| **WHY THIS NEEDS A HUMAN** | The specific thing the classifier couldn't resolve |
| **WHAT THEY WROTE** | The substance of the message, quoted, so you don't have to open the email |
| **SUGGESTED NEXT STEP** | What the classifier thinks should happen — a suggestion, not an instruction |

---

## 5. Why items end up here

Overwhelmingly one reason: **the reply arrived before the change order existed in the Bid Tracker.**

People answer faster than intake creates the record. Someone emails `changeorder@`, colleagues start
discussing it on the thread within the hour, but the row that ties those replies to a change order
hasn't been created yet. The classifier sees a reply about "RFI 254", finds no RFI 254 anywhere, and
correctly refuses to attach it to a different CCHMC job that happens to look similar.

Of the 15 items stuck as of 2026-10-21, **14 are this exact situation.**

Other reasons, less common:

- The message is internal PH+B discussion, not a vendor response, and fits none of the reply types
  the classifier recognises (quote / question / answer / declined).
- A vendor replied with something ambiguous.
- `changeorder@` was CC'd on a conversation that isn't really about intake at all.

**Refusing to guess is deliberate.** The rule the classifier works to is *"a silent guess is a
failure."* Attaching a reply to the wrong change order is far more damaging than leaving it for a
person, because a wrong attachment is invisible and propagates. An item in `_needs_review` is the
system working correctly, not failing.

---

## 6. The exception — items that *don't* get a note

If the classifier **did** identify the change order but still wasn't confident enough to act, it
doesn't write a note. Instead it **flags the row in the Bid Tracker** for review.

So a flagged item appears in one of two places, never both:

| Situation | Where it shows up |
|---|---|
| No change order identified | A note in `_needs_review` |
| Change order identified, but low confidence | A flag on that row in `Bid Tracker.xlsx` |

This is why the count of notes is lower than the count of flagged items. As of 2026-10-21 there were
14 notes for 15 stuck items — two of them (2026-07-30 and the FCx reply of 2026-08-24) went to the
Bid Tracker instead.

**Practical consequence: checking `_needs_review` alone is not sufficient.** You also need to watch
the review flag on the tracker.

---

## 7. What was broken, and what was fixed on 2026-10-21

**The bug.** The automation (`CO Response 2 - Update Tracker & File Quotes`) wrote the note correctly
every time, but had no step to move the email out of the incoming queue. So flagged emails stayed in
`_to_classify` permanently. Every later classifier run looked at them, saw they'd already been read,
and skipped them. No error was ever produced — runs showed green.

The visible symptom was a run report saying `nothing to process` while sixteen emails sat in the
queue, the oldest from July 30.

**The fix.** A step named `Move_the_item_to_needs_review` was added to the review branch of that
flow. It is a copy of the step that already worked on the normal path, with the destination changed
from `_processed` to `_needs_review`. Verified the same day against both a test item and a real one.

**What the fix does not do.** It only applies to emails classified *after* 2026-10-21. The backlog
that built up between July and October does not move on its own and has to be cleared separately.

---

## 8. The gap that remains

**Nothing tells anyone that an item is waiting.** No email, no notification, no dashboard. The folder
has to be opened deliberately.

This is how fourteen notes accumulated from July to October without anyone reading one. The notes
were written correctly and on time; they were simply never looked at. The fix on 2026-10-21 makes
items *arrive* in the folder properly, but arriving somewhere nobody checks is only half a solution.

**Until that's addressed, someone needs to open `_needs_review` on a routine — weekly at minimum.**

> **Platform, since 2026-10-21 (Phase 1, read-only).** The Change Orders module
> has a *Needs Review* tab that lists this folder's notes with a live count,
> grouped by subject, each with the email it is about from the mailbox. It
> reads the folder and changes nothing in it; step 4 of §9 is still done by a
> person in SharePoint. It needs a folder grant that was requested the same
> day; until then the tab says it is not connected. `runbook.md` → *Needs Review*.

A small Power Automate flow emailing a named person whenever a file lands in that folder would close
this, and would be the only monitor in the pipeline that actively tells a person something needs
attention rather than waiting to be found. Not built as of 2026-10-21.

---

## 9. Working an item — suggested routine

1. Open `_needs_review` and sort by date.
2. For each note, read **WHY THIS NEEDS A HUMAN** and **WHAT THEY WROTE**. That's usually enough to
   decide; the email folder beside it has the full message and attachments if you need them.
3. Decide which of these it is:

   - **Needs a change order created.** Most common. Get it through intake so a Bid Tracker row
     exists, then carry the content of the reply into that CO by hand.
   - **Needs a human reply.** Someone asked a question that the pipeline can't answer. Reply from
     Outlook yourself — see §10, the system will not send anything.
   - **Needs a tracker correction.** A vendor shouldn't be on the expected-respondent list, a due
     date is wrong, that sort of thing.
   - **Nothing — close it.** Internal chatter, acknowledgements, automated notifications.

4. When handled, move the note and the email folder into `_archive/`.

> **Don't delete the `classification_result.json` inside an item folder** unless you specifically
> want the classifier to look at that email again from scratch. Its presence is what stops the item
> being reprocessed every run.

---

## 10. What this folder is *not*

- **It is not an outbox.** Nothing in `_needs_review` is waiting to be sent. These are inbound
  emails that already arrived.
- **It is not a draft queue.** The pipeline does create drafts in `changeorder@` — vendor pricing
  reminders and bid-leader handoffs — but those come from different automations that work fine and
  have nothing to do with this folder.
- **The classifier never sends email.** That is a hard rule in its instructions. Any reply to anyone
  in this folder is a person writing it manually.
- **It is not an error log.** An item here usually means the system behaved correctly and declined
  to guess.

---

## 11. Related facts worth knowing

- The classifier runs as a **scheduled task on one person's desktop machine**, twice each weekday.
  If that machine is asleep, the run does not happen and nothing anywhere reports the miss. This was
  documented on 2026-08-19 and remains open.
- The automation checks `_to_classify` **once a minute**, so a newly classified item reaches
  `_needs_review` within about a minute.
- Replaying an old automation run ("Resubmit") is **unreliable** for these items — three of four
  attempts on 2026-10-21 failed. Not a usable way to clear a backlog.
- `_needs_review` and `_processed` are both owned by the automation. The standing rule is that
  Power Automate, not a person and not the classifier, moves items between queue folders.

---

## 12. Open items as of 2026-10-21

| # | Item |
|---|---|
| 1 | **15 emails still stuck** in `_to_classify` from July–October. Need clearing by hand or by re-triggering. |
| 2 | **FCx replied on 2026-08-24** asking whether a pricing reminder was meant for them. Never answered. They remain on the expected-respondent list for CCHMC RFI 229, so reminders keep going out and that CO can never register as complete. |
| 3 | **RFI 254 has no Bid Tracker row.** A scope decision made on the thread 2026-10-05 (flex connectors wherever systems cross the building expansion joint, plus added roof duct supports) is recorded nowhere. |
| 4 | **B&G flex connector material price** still outstanding. Open since August. |
| 5 | **No notification** when something lands in `_needs_review`. §8. |
| 6 | **Replies outrun intake.** The root cause behind 14 of the 15. Today's fix makes it visible, not absent. |
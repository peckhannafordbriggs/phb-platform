# Phase 14 — the spec and prompt edits for cutover day (items 2.3 and 2.4)

Drafted 2026-11-02. Applied on cutover day only (`docs/PHASE-14.md` § 9,
step 7), after the repository has become authoritative (item 2.1). Until
then SharePoint stays authoritative, the repository mirror stays a mirror,
and nothing here is pasted anywhere. The two rules being written down are
already how the container classifier behaves (`docs/phase-12-part-e-equivalence.md`
→ *Named divergences*); these edits make the human-readable spec and the
laptop's task say so.

## 1 · The spec: `CO_Response_Agent_SKILL.md` (items 2.3 and 2.4)

**The text is in the repository mirror**, on the `phb-co-engine` branch
`feat/cutover-prep-HOLD`, in `Change Order Step 2/CO_Response_Agent_SKILL.md`,
as three edits and a change-log line. The mirror is the source; this file
does not repeat the wording, so it cannot drift from it.

| Edit | Where in the spec | What it says |
|---|---|---|
| **§ 1.5 Internal senders — decided by code before any model call** | a new subsection after § 1.4, before § 2 | a `@phb1899.com` sender in a vendor thread is never a vendor reply; `other` with no tracker effect when the message carries no vendor content; `needs_human` (`internal_forwarded_vendor_content`) when it forwards or quotes vendor content, with the four signals; the § 2.0 PM completeness match runs first and is untouched |
| **§ 3.1.1 Entry granularity, and the note an answer addresses** | a new subsection after § 3.1, before § 3.2 | one Q&A entry per commitment, not per email, with `render_qa_pdf.py` grouping one email's entries under one heading; the `answers_note` field (the scope-request note an answer addresses), shown as *Note* on the PDF and as `Answers note:` in `qa_log.md`; the entry shape |
| **§ 4.0** | the `qa_log.json` row of the canonical-files table | the row names both rules and points at § 3.1.1 |
| Change log | the top entry | dated 2026-11-02, "in force from the Phase 14 cutover", with the reason the edits are subsections |

**Why subsections and not edits in place.** The container classifier's
prompts are verbatim extracts of named spec sections — § 1.1–1.4 for
classification, § 3.1 for the Q&A log, § 2 for the match, § 3.3 for the bid
leader — with an immutable hash per prompt version. An edit inside any of
those sections would change an extract and force a new prompt version on
cutover day, with no replay behind it. The new subsections carry the same
rules where no extract reaches; `tests/test_cutover.py` and
`tests/test_classifier_prompts.py` in `phb-co-engine` hold the placement, so
the day changes no prompt.

**On the day.** Open the live spec in `Change Order Step 2` on SharePoint
and paste the three edits and the change-log line from the mirror, verbatim.
Then the SharePoint copy and the mirror hash the same, and the image's
drift check (if the shadow is still running that day) stays quiet.

## 2 · The scheduled-task prompt: `co-response-classifier` (the Cowork task)

**Drafted, and not applied to the repository mirror**:
`_live-scheduled-tasks/co-response-classifier/SKILL.md` in `phb-co-engine`
stays a verbatim capture of the laptop's task, as its README requires.
Whether to paste this at all was disagreement 7 in `docs/PHASE-14.md`,
**decided on 2026-11-02: no.** After cutover the task is disabled and runs
only as rollback, and item 4.2 says rollback runs the laptop's rules, so the
laptop stays exactly as it ran through the window. The draft is kept here so
the decision can be reopened with the text in hand; the two additions would
be:

In step **1. CLASSIFY**, append:

> **Internal senders (spec §1.5):** if the sender is `@phb1899.com` and
> step 0 did not match it as a PM completeness reply, do not judge it as a
> vendor reply. With no vendor content it is `other` at high confidence —
> no tracker count, no Q&A entry. If it forwards or quotes vendor content
> (a quoted `From:` with an outside address, a forwarded-message marker, a
> `FW:`/`Fwd:` subject, a non-image attachment) it is `needs_human` with
> reason `internal_forwarded_vendor_content`, the evidence named in
> `review_text`. Skip steps 2–4 for these.

In step **4. Q&A LOG**, append:

> **One entry per commitment, not per email (spec §3.1.1):** an exception
> to a note, a lead time and a price validity in one email are three
> entries. An answer that addresses a numbered note of the scope request
> carries the note's reference in `answers_note`; an answer that resolves a
> logged question carries `resolves`. The renderer groups one email's
> entries under one heading.

Then re-capture the mirror so the repository matches the task again
(`diff -r "$USERPROFILE/Claude/Scheduled" _live-scheduled-tasks` in
`phb-co-engine`, per its README), and make the same edit in
`09 Scheduled Task Prompts VERBATIM` in the SharePoint `CO Process Handoff`
corpus, which is where a new operator is told to paste the prompt from.

## 3 · The intake task prompt: `co-intake-scrub`

No edit. The intake engine's rules are code, and the cutover diff for the
engine is `docs/PHASE-14.md` § 1 (the intake rule, the Bid Tracker write,
the timestamps), none of which is in the prompt.

## Related

- `docs/PHASE-14.md` items 2.1–2.4, § 8 (the prep status for each), § 9
  step 7, and disagreements 6 and 7
- `docs/phase-12-part-e-equivalence.md` → *Named divergences* — the two
  owner's decisions of 2026-10-29 these edits record
- `phb-co-engine` → `Change Order Step 2/CO_Response_Agent_SKILL.md` (the
  mirror, with the edits), `co_classifier/spec_extract.py` (which sections
  the prompts quote), `co_classifier/rules.py` → `internal_vendor_content`,
  `co_classifier/qa_log.py` (`answers_note`), `Change Order Step 2/render_qa_pdf.py`

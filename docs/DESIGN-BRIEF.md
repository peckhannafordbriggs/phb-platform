# Design brief — PHB Internal Platform

Read `CLAUDE.md` first. This brief covers **appearance only**. It changes no behaviour, no
authorization, no service logic, and no test assertion about how the platform works.

---

## The subject, pinned down

Peck Hannaford + Briggs is a mechanical contractor founded in 1899 — piping, sheet metal,
controls, service. The people using this are estimators, project managers, foremen and
superintendents, on a desk monitor during the working day.

The platform's single job: **an operator opens a draft the automation wrote, reads it,
fixes a date, and sends it to a vendor.** Everything else is secondary.

That job sets the discipline for this whole brief. This is not a marketing page. It's a
tool someone uses for hours. So:

> **Identity lives in the chrome. The work surface stays quiet.**

The sidebar, the module headers, the empty states, the sign-in page — those carry the
brand. The message list, the reading pane, the admin table, the BAS charts stay disciplined
and legible. A dense table of vendor emails is not a place for personality.

---

## Colour

The logo is the source. It's a diamond quartered into saturated fields — a mid-century
industrial signage palette, and much more interesting than anything I'd invent. Sample the
real file rather than trusting these hexes exactly; they're read off the image.

| Name | Hex | From | Used for |
|---|---|---|---|
| `phb-purple` | `#532A85` | the dominant field | Chrome: sidebar, headers, primary surfaces |
| `phb-red` | `#E43125` | the PH+B letters | Primary action, and the Change Orders module |
| `phb-cyan` | `#29A9DF` | lower-right quadrant | The BAS module |
| `phb-orange` | `#F2A127` | lower-left quadrant | Warning, attention, amber states |
| `phb-teal` | `#63CBC4` | "SINCE" | Success, healthy |
| `phb-maroon` | `#7C1D3E` | lower centre | Destructive |
| `phb-gold` | `#E8C547` | the centre X | Sparingly — focus rings, the diamond mark |

**The module-colour idea is the one structural use of colour, and it isn't decoration.**
Each module takes one quadrant colour. Change Orders is red, BAS is cyan. A future module
takes orange or teal. The colour tells you which system you're in — it appears in the
sidebar's active state, the module header, and the diamond mark, and nowhere else.

**Neutrals.** Not pure white and not pure black. A slightly cool off-white for surfaces and
a near-black with a faint purple cast, so the greys relate to the palette rather than
sitting beside it. Build a proper 9-step neutral scale; most of the interface is neutral,
and that scale does more work than any accent.

**Restraint on the saturated colours.** They are for state and identity, never for filling
areas. Seven bright colours in a dense table is unusable. If a screen shows more than two
accents at once, something has gone wrong.

**Accessibility is not optional.** Purple on off-white needs checking at small sizes; the
cyan and teal are light and will fail on white if used for text. Every text/background pair
must clear WCAG AA. Never encode meaning in colour alone — pair it with a label, an icon,
or a shape.

---

## Typography

Three roles. Load via `next/font` so nothing renders unstyled.

**Display** — headings, the wordmark, module titles. Something with the geometric confidence
of the logo. Look at **Archivo**, **Bricolage Grotesque**, or **Instrument Sans**. Not Inter,
not Poppins — those read as the default choice.

**UI / body** — everything dense. Legibility at 13–14px in a table is the only criterion.
**Inter Tight** or **Instrument Sans** are both fine here. This face should be invisible.

**Data / mono** — timestamps, message IDs, point names, sensor values, audit rows. Mono for
technical values is *meaningful* in an engineering context, not a stylistic tic: it makes a
column of readings scannable and a Niagara point name readable. **JetBrains Mono** or
**Geist Mono**.

Set a real type scale with deliberate weights. Labels and eyebrows in condensed uppercase
with wide tracking — that echoes the logo's lettering without imitating it.

---

## The signature: the diamond

**The one memorable element, and everything else stays quiet around it.**

The logo is a square rotated 45° and quartered. Take just that shape — a small rotated
square — and make it the platform's mark:

- **The active module indicator.** A filled diamond in the module's colour beside the
  active sidebar item. Hollow when inactive.
- **The section eyebrow.** A small diamond preceding a section label.
- **The loading state.** A diamond that rotates. One idea, used consistently, instead of a
  generic spinner.
- **The empty state.** A large outlined diamond, quartered, at low opacity. Quiet, and
  unmistakably this product.

Do not redraw the logo in CSS and do not rotate real content. One shape, used consistently.

**The real logo file** goes in `/public` and appears in the sidebar header beside the
wordmark, and on the sign-in page. Small — 28–32px in the sidebar. It's an intricate mark
and it turns to mud below that.

**The risk worth taking, contained.** The entire identity sits on the 45° diagonal. Use
that once — a diagonal edge or a quartered colour band in the sidebar header block, below
the logo. Nowhere else. A diagonal in a dense mail list would be a gimmick within a day.

---

## Screen by screen

### Sign-in
The one place to be generous. Logo at real size, the wordmark, one line of purpose, one
button. Purple field, the quartered motif, plenty of space. It's the first impression and
nobody is trying to get work done on it.

### Sidebar
Purple. Logo and wordmark at the top. Sections — `HOME`, `SYSTEMS`, `ADMIN` — as condensed
uppercase eyebrows. Module items with the diamond indicator in their own colour. Employee
name, email, Profile and Sign out anchored at the bottom.

It is the constant. It carries the brand so the rest doesn't have to.

### Change Orders
Three panes. The **reading pane and its editor stay near-monochrome** — the message's own
formatting is the content, and platform colour competing with a vendor's email is actively
confusing.

Red appears in: the module header, the active sidebar diamond, the Send button. The `Draft`
badge, the conflict banner, the blocked-images banner all keep their current *behaviour* and
just get consistent styling.

Message list: tighten the density. Subject, sender, date, an attachment glyph. Subjects in
this mailbox are long and repetitive (`[CCHMC Bulletin 12] Change Order Request — Additional
Information Needed`) so truncation and hierarchy matter more than they would with short
subjects. Consider surfacing the bracketed project tag as its own small element — it's the
thing people actually scan for.

### BAS
Cyan. The dashboards need real care because their semantics are load-bearing:

- **Points at risk must never render green** when the reason is `roll_horizon_unknown`.
  Unknown is not safe. Amber at minimum, and the tile has to say why.
- **Unclassified points** are amber by design — a backlog item, not a fault. Visually
  distinct from at-risk.
- **The chart's gap treatment stays exactly as built** — inserted null, shaded band, written
  list beneath. Three mechanisms on purpose. Style them; don't consolidate them.
- Charts get one accent and a neutral grid. Sensor data is the content.

### Admin
The most table-heavy screen, so the most disciplined. Purple header, neutral table, colour
only in status pills and grant indicators. Zebra striping or hairline rules — pick one.

The audit log reads as sentences already. Set it as prose, not as a data grid, because
that's what it is.

### States
Loading, empty, and error appear constantly and are usually an afterthought. They're where a
tool feels finished or doesn't.

- **Loading** — skeletons matching the real layout, not spinners that shift it. The rotating
  diamond for anything genuinely indeterminate.
- **Empty** — the Drafts folder is empty most of the day. That state must read as *"nothing
  to review"*, calm and normal, not as a failure. The quartered diamond at low opacity.
- **Error** — every one needs an action. Retry, reload, or go back. Never a Graph error
  string, never a dead end.

---

## Constraints — do not break these

- **Do not restyle the sanitized email body iframe.** Its `sandbox` attributes, CSP, remote
  image blocking and CSS allowlist are security boundaries. The iframe *chrome* is yours;
  what's inside it is not.
- **Do not change the CSS sanitizer allowlist.** It works by omission — no property that can
  name a URL is on it. Adding one to make something look better opens the read-receipt hole
  that blocking remote images exists to close.
- **Do not change behaviour.** No new actions, no combined actions, nothing that sends. The
  send confirmation dialog keeps its confirmation. Guardrails stay.
- **Do not break semantics for aesthetics.** The BAS tile colours and the chart's gap
  treatment encode facts about data loss.
- **All existing tests must pass.** If a test asserts a class name or literal text, update
  the test deliberately and say so — don't silently change what it's checking.
- **No heavy animation dependency.** Tailwind transitions and CSS are enough. If something
  genuinely needs orchestration, one small library, and say why.
- **Respect `prefers-reduced-motion`.** Every transition.
- **Keyboard focus must stay visible** everywhere, and gold focus rings need contrast
  checking.
- **Responsive down to mobile.** Not the primary target, but it shouldn't be broken.

---

## On the reference libraries

They're worth reading for ideas; most are the wrong register for this. Magic UI and React
Bits are largely landing-page components — shimmer, beams, marquees, scroll reveals. In a
tool used daily those become irritating within a week. 21st.dev is the closest fit and worth
browsing widely, not just the dashboards.

**Cherry-pick patterns, don't adopt a kit.** A good skeleton loader, a well-built table, a
tasteful hover state — yes. Anything that animates on scroll or draws attention to itself —
no.

---

## Process

Work in two passes, and show me the first before writing much code.

**Pass one — the plan.** Sample the logo for real hexes. Name the palette as tokens. Pick
the three typefaces and say why each. One ASCII wireframe of the sidebar and one of the
Change Orders view. State the signature element and the one diagonal moment.

Then critique your own plan before building: **would this look the same for any internal
business tool?** If a decision would, it isn't a choice — revise it and say what changed.

**Pass two — build.** Tokens first, in one place. Then the sidebar and sign-in, since they
carry the identity. Then module headers and states. The dense surfaces last, and lightly.

Take a screenshot as you go if you can. Then remove one thing — whichever accent, border or
transition is doing the least work.

---

## The test for whether this worked

An estimator opens the platform on a Tuesday morning, reviews four vendor drafts, and sends
them. They don't notice the design at all — but if you showed them a screenshot of this and
a screenshot of any other internal tool, they'd know instantly which one was theirs.

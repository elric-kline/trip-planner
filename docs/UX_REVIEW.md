# Mobile UX review — findings and remediation plan

Reviewed August 2026 against `49df2cc`. The app was run locally and driven in
Chromium at an iPhone 14 viewport (390×844, DPR 1, touch enabled) as three
roles: anonymous visitor, Master Planner creating a trip, and an invited member
joining by link. Findings marked **[observed]** were reproduced end to end in
the running app, not inferred from source.

Full write-up with screenshots:
<https://claude.ai/code/artifact/589815d2-8427-4777-bb11-54cc96b27d3c>

26 findings — 8 critical, 15 serious, 3 polish.

## Root cause

Two structural habits explain most of the "clunky, repetitive, awkward
expansions" complaints:

1. **The trip page renders every affordance for every state at once.** The
   People list and invite form sit outside the tab switch, so they render below
   all three tabs. The add-item form renders permanently expanded at the bottom
   of two tabs, differing only by a hidden `visibility` input. Nothing is
   sequenced, so nothing flows.
2. **The item page renders every form for every category at once.** Three
   stacked always-open forms with three separate Save buttons and no read view.

Underneath both sits a product gap: there is no way for a member to express a
preference on a proposal, so the "vote" in "pitch ideas, vote, and lock in an
itinerary together" does not exist.

## Findings by journey stage

Severity in brackets. Numbers in parentheses are the plan item that fixes it.

### Arriving and signing in

- **[serious]** Sign-in stacks a magic-link form and a password form separated
  by "or, if you've set one", so the user must self-diagnose whether their
  account has a password. Two identical `you@example.com` fields.
- **[serious]** "Create a password" is wedged between accepting an invite and
  reaching the trip. **[observed]** A member who skips it ends with no password,
  while the password form stays visible and non-functional for them.
- **[polish]** The homepage has one button and no argument — no screenshot, no
  example, no "got an invite link?" path.

### Starting a trip

- **[critical]** Creating a trip lands on **Agreed** — the one tab that cannot
  have content on a new trip. Five identical cards read "Nothing locked yet" and
  "No wake/sleep or stops set yet"; the only button on screen is *Create invite
  link*, below the fold. (04)
- **[serious]** `Destination timezone (IANA)` is a required field hardcoded to
  `America/Mexico_City` regardless of destination. Timezone drives the conflict
  engine, so missing it corrupts every time on the trip.

### Getting the group in

- **[critical]** The invite link is printed as raw text in a `<code>` block with
  no copy button and no share sheet. On a phone this requires long-press and
  drag-select across a 32-character token. (05)
- **[serious]** "Invite by email (optional)" sends no email. What it actually
  does is invisible: the invite becomes scoped to that address, so the link
  stops working for anyone else. Neither behaviour is stated.
- **[polish]** People are raw email addresses everywhere — People list, RSVP
  roll-call, and three times per day card in the location checkboxes. Name is
  optional and nothing prompts for it on join.

### Proposing something

- **[critical]** The add-item form is permanently expanded at the bottom of
  PlaySpace and Scratchpad — roughly 40% of page height, always, below five day
  cards and the Ideas list. (06)
- **[serious]** Choosing a category injects up to 13 fields mid-form, pushing
  the Add button ~700px down the page. Nobody has a confirmation number for a
  restaurant they are still proposing. (07)
- **[serious]** The mid-list insert control in `DayItemBuilder` is `opacity-0`
  revealed on `group-hover`, inside a 12px strip. Touch devices have no hover,
  so the interaction does not exist on the primary device.

### Deciding together

- **[critical]** RSVP renders only when an item is already `locked` **and**
  `optional` — after the decision. During the phase where the group is meant to
  converge there is no vote, no thumbs-up, no comment. (12)
- **[critical]** **[observed]** The only action a member is offered on a
  teammate's proposal is *Decline*. Pressing it throws them off the item onto
  the *Agreed* tab under `error=Only the person who added this, or a planner,
  can decline it`. Every sibling action is permission-gated before render
  (`shareAllowed`, `unlockAllowed`, `editable`, `canLockItem`); this one is not.
  (01)
- **[serious]** No comments, no activity feed, no notifications. The real
  conversation stays in the group chat this product exists to replace. (16)

### The item page

- **[critical]** Three stacked always-open forms, three Save buttons, no read
  view. Which Save writes which fields is never signalled. (08)
- **[serious]** Location is asked for twice with two near-identical
  explanations — `Location` in the Edit block and `Address` in Lodging details.
- **[serious]** A member's item page shows title, status badge, a date form and
  Decline. No notes, no proposer, no cost, no link — nothing supporting the
  decision they are implicitly being asked to make.

### Locking it in

- **[serious]** **[observed]** PlaySpace's copy promises conflict detection it
  does not perform. Two items overlapping by 90 minutes sat in the same day card
  with no warning. `conflictsForViewer` and `dietaryWarningsForViewer` both
  filter to `status: "locked"`. (13)
- **[serious]** **[observed]** The lock preview reported "No new conflicts for
  anyone" while locking a directly overlapping item — the overlapping item was
  locked `optional` with no RSVPs, so it was on nobody's timeline. Defensible
  logic, misleading sentence at the moment of commitment. (15)
- **[polish]** The required-vs-optional lock preview is the best decision UI in
  the product and is two taps deep behind a collapsed day card.

### Living with the plan

- **[serious]** Six kinds of structural repetition on one screen: People +
  invite ×3 (below every tab), the add form ×2, the Declined section ×2, the day
  rows ×2 (two components, two different empty strings), "Nothing locked yet"
  ×5 on an empty trip, member checkbox rows ×3 per day editor. An expanded day
  still prints a summary of the items listed directly beneath it, and every row
  in *Agreed* carries a `locked` badge in a tab that only contains locked items.
  (09, 10)
- **[critical]** The day card has two adjacent expanders doing unrelated things.
  The header row opens the item list; the ✏️ opens a three-section wake/sleep/
  stops editor and measures **20×16px** against a 44px minimum. (11)
- **[serious]** The conflict alert names both items and links neither, and the
  offending rows in the list below carry no visual mark. (14)

### Across every screen

- **[critical]** `.input` is 14px with `py-2` (38px tall). iOS Safari auto-zooms
  any field under 16px on focus and does not zoom back. `.btn-primary` and
  `.btn-secondary` are ~30px tall. Measured sub-44px targets on the trip page:
  day pencil 20×16, day header row 324×20, *Create invite link* 138×38, invite
  email field 213×38. (02)
- **[serious]** 22 fixed multi-column grids with no responsive prefix, four of
  them three-up. At 390px a `grid-cols-3` yields ~105px columns, truncating
  placeholders to "Contact nan", "Contact ph", "Confirmation numbe", "Paymen".
  In `AddItemForm.tsx` (10), `items/[itemId]/page.tsx` (6),
  `TransportLegsEditor.tsx` (3), `DiningEditForm.tsx` (2), `trips/new/page.tsx`
  (1). (03)
- **[serious]** Explanatory copy is `text-xs` (12px) in `stone-400` — roughly
  2.4:1 against `stone-50`, below the 4.5:1 WCAG AA minimum. The sentence
  explaining what PlaySpace is for is the faintest type on the page.

## What is working and should be protected

- The three-tab model (Scratchpad / PlaySpace / Agreed) is a good conceptual
  split: private thinking, group deliberation, settled record.
- Tabs as `?tab=` search params — linkable, bookmarkable, no JS required.
- The magic-link confirm step requires a POST to redeem, so mail scanners
  cannot burn a one-time link with a GET.
- Split wake/sleep locations with per-member inclusion models a genuinely hard
  real-world case.
- The join wizard appears only when there is a real fork to resolve, and is
  skippable.
- The required-vs-optional lock preview with per-person impact.
- No horizontal overflow at 390px anywhere tested; `aria-current` is correct on
  tab navigation.

## Remediation plan

Ordered by ratio of journey improvement to effort, not by severity.

### Tier 1 — Stop the bleeding

About a day. Removes dead-ends and unblocks the phone.

| # | Change | Notes |
|---|---|---|
| 01 | Gate the Decline button on `checkDecline` | One line. Removes a guaranteed failure on the only action members are offered |
| 02 | 16px inputs, 44px buttons, 44px pencil hit area | Four declarations in `globals.css`; stops iOS zoom product-wide |
| 03 | Single-column grids by default, `sm:` above 640px | 22 sites. Not blind find-and-replace — see caveat below |
| 04 | Redirect newly created trips to PlaySpace | One line in `createTripAction` |
| 05 | Replace the raw invite URL with a Share button | `navigator.share()` with clipboard fallback and a confirmation |

**Caveat on 03:** a few sites should stay multi-column. The start/end date pair
on `trips/new` is fine 2-up, and one transport `grid-cols-2` pairs a select with
an "International" checkbox label that reads oddly at full width. Review each.

### Tier 2 — Make it flow

A sprint. This is the answer to "it doesn't flow naturally through a journey."

| # | Change | Notes |
|---|---|---|
| 06 | One summoned add form, not two permanent ones | Bottom-anchored `+ Add` opening a sheet; removes the largest block of repetition and ~⅓ of PlaySpace's scroll depth |
| 07 | Move booking detail off the add form onto the item page | Add becomes title / category / where / when. The detail forms already exist on the item page |
| 08 | Item page read view with a single Save | The `<dl>` already rendered for non-editors is the right default for everyone |
| 09 | Move People and invite into the trip header | Face pile plus *Share invite*; deletes three duplicate renders |
| 10 | Quiet the day cards | Suppress the summary line while a day is open; drop the redundant `locked` badge inside Agreed |
| 11 | Day setup opens in a sheet from inside the expanded card | Removes the accidental-tap expander and stops the editor displacing the itinerary |

**Do not** merge `DayCard` and `PlaySpaceDayCard` into one component. They
diverge for real reasons — `DayCard` owns the wake/sleep editor and
viewer-filtered locations, `PlaySpaceDayCard` owns `DayItemBuilder`. A mode flag
would cost more than the duplication.

### Tier 3 — Close the product gap

The next cycle. This is what makes it a group product rather than a shared note.

| # | Change | Notes |
|---|---|---|
| 12 | Let members say yes before the decision, not after | An *I'm in* toggle on proposals with a face pile and a count on the day row |
| 13 | Run conflict analysis on proposals and surface it in PlaySpace | The engine exists; the copy already claims the feature |
| 14 | Make the conflict alert actionable | Link both titles, mark the offending rows, add a direct path to fix the time |
| 15 | Say what the lock preview actually checked | "No conflicts for the 1 person who has RSVP'd" beats a confident "none for anyone" that is not true |
| 16 | Add a comment thread per item | The cheapest answer to "why is this here?" |

## Which items need which model

Most of this is straightforward execution. The split is not by size — it is
whether the item has a decided answer that needs implementing, or requires
deciding something with consequences elsewhere in the system.

| # | Model | Reason |
|---|---|---|
| 01–05 | Sonnet | Decided changes; 01 copies an existing pattern, 02–04 are one-liners, 05 is self-contained |
| 06 | **Opus** to design, Sonnet to extend | Interaction design (placement, dismissal, focus management, how it coexists with day-scoped adds), not code volume |
| 07 | Sonnet | Delete fields, stop writing detail rows on create. Touches the integration tests |
| 08 | **Opus** | A permissions refactor wearing a layout refactor's clothes — see below |
| 09–11 | Sonnet | 11 depends on 06's sheet primitive |
| 12 | **Opus** | Schema fork with downstream consequences — see below |
| 13 | **Opus** | The membership model has no answer for proposals — see below |
| 14 | Sonnet | `ScheduleFinding.before/after` are `ScheduleItem`, which carries `id`. Linking is purely presentational |
| 15 | Sonnet | Surface the awaiting-RSVP set; small logic plus wording |
| 16 | Sonnet | New table, action, component. Well-trodden |

### Why 13 needs judgement

`groupTimelineFor` decides whose timeline an item belongs on with
`commitment === "required" || rsvp === "yes"`. Proposals have neither —
`commitment` is null until lock. So there is no "remove the `status: "locked"`
filter" fix: either the result is empty, or every proposal lands on everyone's
timeline. Competing proposals **overlap by design** — that is what proposing
alternatives means — so the naive version ships a permanent red banner
announcing that the two Saturday options cannot both happen. The real work is a
second, quieter finding type ("these two cannot both happen") distinct from
"your day is broken." A change that pattern-matches on the filter will pass unit
tests and be unusable.

### Why 12 is coupled to 13

`item_rsvps` is keyed `(itemId, userId)` and is read by `attendanceFor`,
`myRsvp`, `checkRsvp`, `groupTimelineFor` and `previewLockImpact`. Reusing it
for proposals is free and tempting, and silently gives proposals attendees —
which feeds straight into 13. Reuse-versus-new-table is a real fork. Decide 12
and 13 together.

### Why 08 is riskier than it looks

There are four independent editability gates and they deliberately disagree:
`editable` requires the item not be locked, but `lodgingEditable`,
`diningEditable` and `transportEditable` do not — because a confirmation number
arrives *after* the lock. Collapsing three forms into one Save is exactly what
flattens that asymmetry, and a locked item would either lose booking-detail
editing or wrongly regain title editing. The layout is the easy half.

## Verification

The 20×16px pencil and the hover-only insert gap were both found by driving the
app, not by reading it. Neither appears in a diff or a test run. Whoever picks
up tiers 1 and 2 should be able to run the app and screenshot at 390px —
otherwise the result is correct in source and unverified in the hand.

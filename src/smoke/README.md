# Smoke layer

Coverage for `src/app`, which nothing else tests.

```sh
npm run build      # required — smoke runs against the production build
npm run test:smoke
```

Needs the same live Postgres `npm run test:integration` does. In CI it's the
`smoke` job.

Two files, two questions:

| File | Asks |
| --- | --- |
| `flows.smoke.ts` | Did this land in the right place? |
| `layout.smoke.ts` | Is the place it landed usable in a hand? |

## What `flows.smoke.ts` asserts

Three things, and deliberately nothing else:

1. **HTTP status** of a page.
2. **Where a redirect chain finally lands** — the pathname, plus named query
   params where the redirect carries state.
3. **That nothing threw or logged an error in the browser.**

## What `layout.smoke.ts` asserts

Four rules, at 390×844, applied to *every element on the page* rather than to
named selectors — so there's nothing to keep in sync with the markup, and a
new page is covered the moment it joins the route list:

1. **No interactive target under 44px.** For a checkbox or radio the label
   wrapping it is measured, since that's what a thumb lands on.
2. **No text field under 16px** — the threshold below which iOS Safari zooms
   the viewport on focus and never zooms back.
3. **No horizontal overflow** of the document.
4. **No `<input>` placeholder clipped by its own field**, measured on a canvas
   with the field's computed font.

Each rule exists because this app shipped a defect it would have caught: the
FAB covering the last row at full scroll, a support badge wrapping mid-row,
`inline-block` beating `inline-flex` in the unlayered component classes, six
16px checkbox labels in the day-setup sheet, "Sign out" wrapping beside a long
name, and "Invite by email (optional)" clipped after the 16px bump.

Rules, not screenshots. Screenshot comparison fails on every intentional
change, needs baseline curation, and drifts with font rendering across
runners — and none of the defects above was pixel drift.

## What does not belong here

No assertions about text, element counts, visibility, or styling.

That restraint is the point rather than laziness. Manual Playwright passes over
this app have repeatedly produced "findings" that turned out to be bugs in the
*harness*: a closed `<dialog>` counted as rendered, `find()` over `main div`
returning the outermost match so a banner check silently degraded into "is this
string anywhere on the page", `button:has-text("Delete")` matching two
different buttons, `networkidle` racing a server-action redirect. Every one of
those failed quietly in the direction of passing.

A URL cannot be asserted subtly wrong. It equals `/trips` or it does not. That
property is what makes this layer safe to gate merges on.

If a check needs to know what's *on* a page, it belongs somewhere that doesn't
need a browser — most of this app's logic is already tested that way under
`src/lib`.

Click targets are the one exception, and they're addressed by accessible name
(`clickButton`). A wrong name times out loudly, so brittleness there is safe in
a way that brittleness in an assertion is not.

## Keeping it honest

A suite that has never failed proves nothing. When adding a test, break the
behaviour it covers and watch it go red before trusting it.

The mutations each layer was verified against, all caught:

| Mutation | Caught by |
| --- | --- |
| Reinstate the `/login/set-password` detour in `confirmSignIn` | "redeeming a link lands where you were going" |
| Drop the `/welcome` branch from `acceptInviteAction` | "asks a nameless joiner for a name, once" |
| Send a non-member to `/profile` instead of `/trips` | "a non-member opening a trip URL" |
| `console.error` in a client component | "a signed-out visitor gets the homepage" |
| Remove `min-h-11` from `.check-label` | touch-target |
| Put `.input` back to `text-sm` | ios-zoom-font |
| A 900px-wide element on the homepage | horizontal-overflow |
| A placeholder too long for its field | clipped-placeholder |

Two of those only worked after fixing something first, and both lessons
generalise:

- **`console.error` in a client component** went undetected until
  `waitForHydration` existed. At `domcontentloaded` no client component has
  run, so the console looks clean on a page that is about to throw. Anything
  asserting on client behaviour has to settle first.
- **The clipped placeholder** went undetected because the passport form it was
  in only renders when `PASSPORT_ENCRYPTION_KEY` is set — so that entire
  section of Profile had never been checked by anything. The harness now
  supplies a throwaway key. If a page hides a section behind config, the smoke
  run has to supply that config or it is silently testing less than it looks.

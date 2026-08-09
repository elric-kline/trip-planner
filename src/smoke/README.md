# Smoke layer

Route and redirect coverage for `src/app`, which nothing else tests.

```sh
npm run build      # required — smoke runs against the production build
npm run test:smoke
```

Needs the same live Postgres `npm run test:integration` does. In CI it's the
`smoke` job.

## What this layer asserts

Three things, and deliberately nothing else:

1. **HTTP status** of a page.
2. **Where a redirect chain finally lands** — the pathname, plus named query
   params where the redirect carries state.
3. **That nothing threw or logged an error in the browser.**

## What does not belong here

No assertions about text, element counts, visibility, styling, or layout.

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

The four mutations this layer was originally verified against, all caught:

| Mutation | Caught by |
| --- | --- |
| Reinstate the `/login/set-password` detour in `confirmSignIn` | "redeeming a link lands where you were going" |
| Drop the `/welcome` branch from `acceptInviteAction` | "asks a nameless joiner for a name, once" |
| Send a non-member to `/profile` instead of `/trips` | "a non-member opening a trip URL" |
| `console.error` in a client component | "a signed-out visitor gets the homepage" |

That last one only started failing once `waitForHydration` existed — at
`domcontentloaded` no client component has run yet, so the console looks clean
on a page that is about to throw. Anything asserting on client behaviour has to
settle first.

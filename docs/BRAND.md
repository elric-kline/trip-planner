# AgreeMobile visual identity

Agree + Automobile: a site that gets the group aligned on the itinerary instead
of arguing about it in a group chat. The identity leans into that pairing —
warm, road-trip color; a mark that reads as "confirmed stop on the map."

## Logomark

`src/components/logo.tsx` exports `LogoMark` (icon only) and `Logo` (icon +
wordmark). It's a map pin with a checkmark inside — the trip, agreed on. One
shape, single fill color via `currentColor`, so it survives being shrunk to a
16px favicon (`src/app/icon.svg`) or dropped on a dark background.

Use `LogoMark` alone in tight spaces (favicons, app icons, loading states).
Use `Logo` wherever the product name should appear — it renders "Agree" in
pine and "Mobile" in route, rather than a plain wordmark, so the pun in the
name stays visible.

Don't recolor the mark to a semantic status color (amber/emerald/red/blue) —
those are reserved for trip state (see below) and mixing them into the brand
mark would blur the two systems.

## Color

Defined as Tailwind v4 theme tokens in `src/app/globals.css` (`@theme`), so
they're available as ordinary utilities: `bg-route-600`, `text-pine-700`, etc.

- **Route** (`route-50`…`900`, anchor `route-600` `#C24A2A`) — the brand
  accent: primary buttons, the logomark, links. Terracotta/rust, evoking a
  sunset highway rather than a generic corporate blue.
- **Pine** (`pine-50`…`900`, anchor `pine-700` `#1F3D3A`) — deep teal ink for
  quiet emphasis, currently used in the "Agree" half of the wordmark. Reach
  for it before adding a new color when something needs to feel grounded
  rather than loud.
- **Stone** (Tailwind's built-in neutral scale) stays the neutral backbone —
  backgrounds, body text, borders. Untouched.
- **Status colors** — amber (pending), emerald (agreed/confirmed), blue
  (info), red (conflict/error) — are functional, not brand, and are
  intentionally left as Tailwind's stock colors. They need to stay visually
  distinct from `route` so a "pending" badge never gets confused for a
  call-to-action.

## Type

Two families, loaded via `next/font/google` in `src/app/layout.tsx`:

- **Space Grotesk** (`--font-display`) — headings (`h1`/`h2`/`h3`, wired up
  globally in `globals.css`) and the logo wordmark. Geometric with a slightly
  technical, road-sign character — it's what keeps the identity from
  reading as generic "friendly startup."
- **Inter** (`--font-sans`) — body copy and UI chrome. Chosen for legibility
  in small sizes (form labels, itinerary line items), not for personality.

## Small motifs

`.road-rule` (in `globals.css`) is a dashed horizontal rule — literally a
road's center line — used under the site header. It's a light touch, not a
pattern to scatter everywhere; one per page section is plenty.

## Applying this elsewhere

- Primary actions: `.btn-primary` (now `route-600`, was flat black).
- Secondary actions: `.btn-secondary` — unchanged, stays neutral so it
  doesn't compete with primary.
- Inline links: the new `.link` utility (`route-600`, underlined).
- New UI should reach for `route`/`pine` before reaching for an arbitrary
  hex value or a Tailwind color not already in use on the site.

/**
 * What to call somebody on screen.
 *
 * A name is optional and nothing used to ask for one, so trips rendered as
 * lists of raw email addresses -- in the roster, in every RSVP roll-call, and
 * three times per day card in the location checkboxes. A group of friends
 * planning a holiday shouldn't read like an admin console.
 *
 * Falling back to the local part is a big improvement on the full address for
 * almost no effort: "ana.garcia" beats "ana.garcia@example.com" in a list, and
 * separators become spaces so it reads as a name rather than a handle. It's a
 * fallback, not a replacement -- anyone who sets a real name gets that.
 */
export function displayName(person: { name?: string | null; email: string }): string {
  const given = person.name?.trim();
  if (given) return given;

  const local = person.email.split("@")[0] ?? person.email;
  const spaced = local.replace(/[._-]+/g, " ").trim();
  return spaced || person.email;
}

/**
 * The full address alongside the name, for the few places where knowing which
 * account somebody actually is matters -- the roster a planner manages roles
 * from, mostly.
 */
export function displayNameWithEmail(person: { name?: string | null; email: string }): string {
  const shown = displayName(person);
  return shown.toLowerCase() === person.email.toLowerCase() ? person.email : `${shown} · ${person.email}`;
}

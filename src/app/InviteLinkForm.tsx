"use client";

import { useState } from "react";

/**
 * Invite links arrive in a group chat, and on a phone they're as often copied
 * as text as they are tapped -- forwarded into another thread, pasted into a
 * note, quoted in a reply. Someone in that position had nowhere to go from the
 * homepage: the only button was "Sign in", which lands you on /trips with no
 * trip in it and no hint that the link you're holding was the way in.
 *
 * This takes whatever they paste and pulls the token out of it. Entirely
 * client-side -- it's a navigation aid, not a lookup. Whether the token is real
 * (or expired, or scoped to a different address) is still settled by
 * /invite/[token], which is the one place that knows.
 */
export default function InviteLinkForm() {
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const raw = String(new FormData(e.currentTarget).get("link") ?? "").trim();
        // Matches a whole link, or just the token pasted on its own. base64url
        // is the alphabet createInvite generates from (see trips.ts).
        const token = raw.match(/(?:\/invite\/)?([A-Za-z0-9_-]{16,})/)?.[1];
        if (!token) {
          setError("That doesn't look like an invite link — paste the whole thing, including the https://.");
          return;
        }
        window.location.href = `/invite/${token}`;
      }}
      className="mt-3"
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          name="link"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Paste your invite link"
          aria-label="Invite link"
          className="input"
        />
        <button type="submit" className="btn-secondary shrink-0">
          Go
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}

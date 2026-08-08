"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary for a trip page -- without this, any unhandled
 * exception anywhere under here (including a Server Action's own render
 * after it returns, e.g. sending an assistant message) surfaces as Next's
 * generic, dead-end "Application error: a client-side exception has
 * occurred" page with no way back except a manual reload. This at least
 * keeps the header/nav (only this route segment is replaced, not the root
 * layout -- see layout.tsx) and offers a real retry.
 *
 * Logged to the console via `error` so it still shows up wherever browser
 * errors are already being reported -- this doesn't swallow anything, it
 * just gives the user a way out.
 */
export default function TripError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Trip page error:", error);
  }, [error]);

  return (
    <div className="rounded-md border border-stone-200 bg-white p-6 text-center">
      <h2 className="text-lg font-semibold text-stone-900">Something went wrong</h2>
      <p className="mt-2 text-sm text-stone-500">
        That didn&apos;t go through -- often a slow or dropped connection. Nothing you had is lost; try again.
      </p>
      {error.digest && <p className="mt-2 text-xs text-stone-400">Reference: {error.digest}</p>}
      <button type="button" onClick={reset} className="btn-primary mt-4">
        Try again
      </button>
    </div>
  );
}

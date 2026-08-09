import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, requireTripAccess } from "@/lib/scope.ts";
import { saveNameAction } from "./actions.ts";

/**
 * "What should we call you?", asked once, at the only moment it's obviously
 * worth answering: you've just joined a trip and are about to appear on other
 * people's screens.
 *
 * A name has always been optional and buried in Profile, and nothing ever
 * prompted for one -- so trips rendered as lists of raw email addresses. This
 * is the cheapest place to fix that: the person is already mid-flow, the
 * reason is self-evident, and skipping costs nothing (displayName falls back
 * to the address's local part either way).
 *
 * Only ever shown to somebody who hasn't set a name. Anyone who has goes
 * straight through, so it can't become a step people learn to dismiss.
 */
export default async function WelcomePage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/trip/${tripId}`);

  let access;
  try {
    access = await requireTripAccess(tripId, user);
  } catch (err) {
    if (err instanceof AccessError) redirect("/trips");
    throw err;
  }

  if (user.name?.trim()) redirect(`/trip/${tripId}`);

  return (
    <div className="mx-auto max-w-sm space-y-6">
      <div>
        <h1 className="text-xl font-semibold">You&apos;re in</h1>
        <p className="mt-1 text-sm text-stone-500">
          Welcome to {access.trip.name}. What should the others call you?
        </p>
      </div>

      <form action={saveNameAction.bind(null, tripId)} className="grid gap-3">
        <label className="block text-sm">
          <span className="mb-1 block text-stone-700">Your name</span>
          <input name="name" autoFocus placeholder="Ana" className="input" />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary">
            Continue
          </button>
          <a
            href={`/trip/${tripId}`}
            className="inline-flex min-h-11 items-center text-sm text-stone-500 underline hover:text-stone-700"
          >
            Skip
          </a>
        </div>
      </form>
    </div>
  );
}

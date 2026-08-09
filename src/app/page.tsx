import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import InviteLinkForm from "./InviteLinkForm.tsx";

/**
 * A sample of the real PlaySpace item list, built from the same markup as
 * itemDisplay.tsx's ItemRow -- same structure, same classes, same badges, so
 * it's restyled along with the real thing instead of going stale the way a
 * screenshot would. The strings are illustrative: real rows repeat the date on
 * every line, which is redundant under a card already headed with it and wraps
 * mid-time at 390px.
 *
 * The content is doing the arguing. Two Saturday afternoon options, one with
 * more people in on it and one flagged as clashing with something the viewer
 * already said yes to, plus a dinner already settled, is the whole premise in
 * six lines -- which a headline and a Sign in button never managed on their
 * own.
 */
function SampleDay() {
  return (
    <div aria-hidden className="rounded-md border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-stone-700">
          <span className="mr-1 inline-block w-3 text-stone-400">▾</span>
          Saturday, June 13
        </h3>
      </div>
      <ul className="mt-4 divide-y divide-stone-200 rounded-md border border-stone-200">
        <li>
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <div className="font-medium">Cliffs of Moher</div>
              <div className="text-sm text-stone-500">
                1:00 PM – 4:00 PM · Doolin
                <span className="whitespace-nowrap font-medium text-emerald-700"> · 5 in</span>
              </div>
            </div>
            <span className="badge bg-blue-100 text-blue-800">proposed</span>
          </div>
        </li>
        <li>
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <div className="font-medium">
                <span className="mr-1.5 text-amber-600">⚠</span>
                Kayaking in Kinvara
              </div>
              <div className="text-sm text-stone-500">
                2:00 PM – 5:00 PM
                <span className="whitespace-nowrap font-medium text-emerald-700"> · 2 in</span>
              </div>
            </div>
            <span className="badge bg-blue-100 text-blue-800">proposed</span>
          </div>
        </li>
        <li>
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <div className="font-medium">Dinner at Moran&apos;s</div>
              <div className="text-sm text-stone-500">7:30 PM · Kilcolgan</div>
            </div>
            <span className="badge bg-emerald-100 text-emerald-800">locked</span>
          </div>
        </li>
      </ul>
      <p className="mt-2 text-xs text-amber-700">⚠ Kayaking clashes with the Cliffs of Moher — you&apos;re in for both.</p>
    </div>
  );
}

const POINTS = [
  {
    title: "Ideas stay separate from decisions",
    body: "Anything anyone suggests lives in the PlaySpace until the group actually agrees on it. Locking it in moves it to the itinerary — so nobody has to guess whether a plan is real yet.",
  },
  {
    title: "It catches the clashes",
    body: "Say you're in for something and the trip checks it against everything else you've said yes to. Overlapping times get flagged on the day they'd happen, not on the morning of.",
  },
  {
    title: "Not everyone has to do everything",
    body: "People split up. Two groups can wake in different cities, take different stops, and rejoin for dinner — everyone sees their own day, and the planner sees all of them.",
  },
];

export default async function HomePage() {
  const user = await getCurrentUser();
  if (user) redirect("/trips");

  return (
    <div className="mx-auto max-w-2xl pb-8">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-pine-700">
          Plan trips your group actually agrees on.
        </h1>
        {/* The old subhead promised "keep it as a shared journal once you're
            there." There is no journal — the word appears nowhere in the app.
            Replaced with what it does do, which is enough of a pitch. */}
        <p className="mx-auto mt-4 max-w-lg text-lg text-stone-600">
          Pitch ideas, talk them over, see who&apos;s in, and lock in an itinerary the whole group
          has actually agreed to.
        </p>
        {/* Full-width stacked on a phone, side by side once there's room. The
            second one isn't decoration: roughly everyone after the first
            planner arrives holding a link, not looking for a product. */}
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
          {/* Carries the intent through the sign-in: this button means "make a
              trip", so it lands on the trip form afterwards rather than the
              (empty) trip list. */}
          <a href="/login?next=%2Ftrips%2Fnew" className="btn-primary">
            Start a trip
          </a>
          <a href="#invite" className="btn-secondary">
            I have an invite link
          </a>
        </div>
      </div>

      <div className="mt-10">
        <SampleDay />
      </div>

      <div className="mt-10 space-y-6">
        {POINTS.map((point) => (
          <div key={point.title}>
            <h2 className="text-lg font-semibold text-pine-700">{point.title}</h2>
            <p className="mt-1 text-stone-600">{point.body}</p>
          </div>
        ))}
      </div>

      <div id="invite" className="mt-10 scroll-mt-4 rounded-md border border-stone-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-pine-700">Got an invite link?</h2>
        <p className="mt-1 text-stone-600">
          Opening it is all you need — you don&apos;t have to make an account first. If you&apos;ve
          only got the link as text, paste it here.
        </p>
        <InviteLinkForm />
      </div>

      {/* Its own row rather than a link inside the sentence: an inline link in
          body text is a ~20px target, and this is a real destination, not a
          reference. */}
      <div className="mt-10 text-center">
        <p className="text-stone-600">Already signed up?</p>
        <a href="/login" className="link inline-flex min-h-11 items-center">
          Sign in
        </a>
      </div>
    </div>
  );
}

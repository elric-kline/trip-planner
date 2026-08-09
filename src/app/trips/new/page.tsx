import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import { createTripAction } from "../actions.ts";
import DestinationTimezone from "./DestinationTimezone.tsx";

export default async function NewTripPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/trips/new");
  const { error } = await searchParams;

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-6 text-xl font-semibold">Start a trip</h1>

      {error && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      <form action={createTripAction} className="space-y-4">
        <Field label="Trip name">
          <input name="name" required placeholder="Oaxaca in October" className="input" />
        </Field>
        {/* Asked only of somebody who hasn't got a name on file, and only
            here and on /welcome -- the two moments a person is about to start
            appearing on other people's screens. The field is `name.self`
            rather than `name` because the trip's own name already owns that
            one. */}
        {!user.name?.trim() && (
          <Field label="Your name">
            <input
              name="name.self"
              placeholder="What the group should call you"
              autoComplete="name"
              className="input"
            />
          </Field>
        )}
        <DestinationTimezone />
        {/* Stays 2-up on mobile: `type=date` renders a short fixed-width value
            (10/10/2026), the two belong together, and stacking them separates a
            pair people read as one range. */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start date">
            <input type="date" name="startDate" required className="input" />
          </Field>
          <Field label="End date">
            <input type="date" name="endDate" required className="input" />
          </Field>
        </div>
        <button type="submit" className="btn-primary w-full">
          Create trip
        </button>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-stone-700">{label}</span>
      {children}
    </label>
  );
}

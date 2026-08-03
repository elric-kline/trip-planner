import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import { createTripAction } from "../actions.ts";

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
        <Field label="Destination">
          <input name="destination" required placeholder="Oaxaca, Mexico" className="input" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start date">
            <input type="date" name="startDate" required className="input" />
          </Field>
          <Field label="End date">
            <input type="date" name="endDate" required className="input" />
          </Field>
        </div>
        <Field label="Destination timezone (IANA)">
          <input
            name="timezone"
            required
            defaultValue="America/Mexico_City"
            className="input"
          />
        </Field>
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

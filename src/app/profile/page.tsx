import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import { getProfile } from "@/lib/profile.ts";
import { DIETARY_TAGS, DIETARY_TAG_LABEL } from "@/lib/dietary.ts";
import { updateProfileAction } from "./actions.ts";

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/profile");

  const profile = await getProfile(user.id);
  const { error, saved } = await searchParams;
  const restrictions = new Set(profile.dietaryRestrictions ?? []);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Your profile</h1>
        <p className="text-sm text-stone-500">{profile.email}</p>
      </div>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {saved && !error && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Saved.</p>
      )}

      <form action={updateProfileAction} className="grid gap-5 rounded-md border border-stone-200 bg-white p-4">
        <label className="block text-sm">
          <span className="mb-1 block text-stone-700">Name</span>
          <input name="name" defaultValue={profile.name ?? ""} className="input" placeholder="Your name" />
        </label>

        <div>
          <p className="mb-1 text-sm text-stone-700">Dietary restrictions (optional)</p>
          <p className="mb-2 text-xs text-stone-400">
            Visible to co-members on any trip you&apos;re on — this is what lets the group avoid picking a
            restaurant that won&apos;t work for you.
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            {DIETARY_TAGS.map((tag) => (
              <label key={tag} className="flex items-center gap-2 text-sm text-stone-700">
                <input
                  type="checkbox"
                  name="dietaryRestrictions"
                  value={tag}
                  defaultChecked={restrictions.has(tag)}
                />
                {DIETARY_TAG_LABEL[tag]}
              </label>
            ))}
          </div>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block text-stone-700">Anything else? (optional)</span>
          <textarea
            name="dietaryNotes"
            defaultValue={profile.dietaryNotes ?? ""}
            className="input"
            rows={2}
            placeholder="Severity, a specific ingredient, anything the checkboxes above don't cover"
          />
        </label>

        <button type="submit" className="btn-primary justify-self-start">
          Save
        </button>
      </form>
    </div>
  );
}

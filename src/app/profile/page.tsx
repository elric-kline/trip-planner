import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import { getProfile } from "@/lib/profile.ts";
import { getPassportDetails, getPassportPhotoDataUri } from "@/lib/passport.ts";
import { isEncryptionConfigured } from "@/lib/encryption.ts";
import { DIETARY_TAGS, DIETARY_TAG_LABEL } from "@/lib/dietary.ts";
import { updateProfileAction, updatePassportAction, removePassportPhotoAction, removePassportDetailsAction } from "./actions.ts";

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

  const passportAvailable = isEncryptionConfigured();
  const passport = passportAvailable ? await getPassportDetails(user.id) : null;
  const photoDataUri = passportAvailable ? await getPassportPhotoDataUri(user.id) : null;

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

      <section className="rounded-md border border-stone-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-semibold text-stone-700">Passport (optional)</h2>
        <p className="mb-4 text-xs text-stone-400">
          For whoever books flights or lodging on your behalf. Stored encrypted, and only visible to a
          trip&apos;s planner on trips you&apos;re actually on — not every co-member, unlike dietary info above.
        </p>

        {!passportAvailable ? (
          <p className="rounded-md bg-stone-50 px-3 py-2 text-sm text-stone-400">
            Not available yet — ask whoever runs this app to finish setting it up.
          </p>
        ) : (
          <>
            <form action={updatePassportAction} className="grid gap-3">
              <div className="grid sm:grid-cols-2 gap-3">
                <input
                  name="fullName"
                  defaultValue={passport?.fullName ?? ""}
                  placeholder="Full name (as on passport)"
                  className="input"
                />
                <input
                  name="passportNumber"
                  defaultValue={passport?.passportNumber ?? ""}
                  placeholder="Passport number"
                  className="input"
                />
              </div>
              <div className="grid sm:grid-cols-3 gap-3">
                <input
                  name="nationality"
                  defaultValue={passport?.nationality ?? ""}
                  placeholder="Nationality"
                  className="input"
                />
                <label className="text-sm">
                  <span className="mb-1 block text-stone-700">Date of birth</span>
                  <input type="date" name="dateOfBirth" defaultValue={passport?.dateOfBirth ?? ""} className="input" />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-stone-700">Expiry date</span>
                  <input type="date" name="expiryDate" defaultValue={passport?.expiryDate ?? ""} className="input" />
                </label>
              </div>

              {photoDataUri && (
                // eslint-disable-next-line @next/next/no-img-element -- a data: URI, not a remote/static asset next/image is built for.
                <img
                  src={photoDataUri}
                  alt="Uploaded passport photo"
                  className="h-32 w-auto rounded-md border border-stone-200 object-contain"
                />
              )}
              <label className="text-sm">
                <span className="mb-1 block text-stone-700">
                  {photoDataUri ? "Replace photo (optional)" : "Photo of the passport page (optional)"}
                </span>
                <input type="file" name="photo" accept="image/jpeg,image/png,image/webp,image/heic" className="input" />
              </label>

              <button type="submit" className="btn-primary justify-self-start">
                Save passport info
              </button>
            </form>

            {(passport || photoDataUri) && (
              <div className="mt-3 flex gap-4">
                {photoDataUri && (
                  <form action={removePassportPhotoAction}>
                    <button type="submit" className="text-xs text-stone-500 underline hover:text-stone-700">
                      Remove photo
                    </button>
                  </form>
                )}
                <form action={removePassportDetailsAction}>
                  <button type="submit" className="text-xs text-red-600 underline hover:text-red-800">
                    Remove all passport info
                  </button>
                </form>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

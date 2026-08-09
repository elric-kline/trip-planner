import { redirect } from "next/navigation";
import { getCurrentUser, hasPassword } from "@/lib/auth.ts";
import { submitPassword } from "./actions.ts";

/**
 * No longer interposed between signing in and arriving -- confirmSignIn goes
 * straight where you were headed. This page is now only reached on purpose,
 * from Profile, so it can say what it is instead of apologising for
 * interrupting, and "Skip for now" becomes an ordinary Cancel.
 */
export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { error, next } = await searchParams;
  const existing = await hasPassword(user.email);

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-1 text-xl font-semibold">
        {existing ? "Change your password" : "Set a password"}
      </h1>
      <p className="mb-6 text-sm text-stone-500">
        For <strong>{user.email}</strong>. You never need one — signing in emails you a
        link — but with a password set you can type it instead.
      </p>

      {error && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      <form action={submitPassword} className="space-y-3">
        <input type="hidden" name="next" value={next ?? "/trips"} />
        <input
          type="password"
          name="password"
          required
          minLength={8}
          autoFocus
          placeholder="New password"
          className="input"
        />
        <input
          type="password"
          name="confirm"
          required
          minLength={8}
          placeholder="Confirm password"
          className="input"
        />
        <button type="submit" className="btn-primary w-full">
          {existing ? "Change password" : "Set password"}
        </button>
      </form>

      <a
        href={next ?? "/trips"}
        className="mt-2 flex min-h-11 items-center justify-center text-sm text-stone-500 underline"
      >
        Cancel
      </a>
    </div>
  );
}

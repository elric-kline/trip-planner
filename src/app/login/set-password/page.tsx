import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";
import { submitPassword } from "./actions.ts";

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { error, next } = await searchParams;

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-1 text-xl font-semibold">Create a password</h1>
      <p className="mb-6 text-sm text-stone-500">
        You&apos;re signed in as <strong>{user.email}</strong>. Set a password so you
        can sign in directly next time, or keep using an email link — whichever&apos;s easier.
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
          Set password
        </button>
      </form>

      <a href={next ?? "/trips"} className="mt-4 block text-center text-sm text-stone-500 underline">
        Skip for now
      </a>
    </div>
  );
}

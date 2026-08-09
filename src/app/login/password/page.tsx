import { redirect } from "next/navigation";
import { passwordLogin, requestMagicLink } from "../actions.ts";

/**
 * The second step for an address that has a password. Reached only from
 * startSignIn, which already established that -- so this page never has to ask
 * "do you have one of these?", which is exactly what the old two-form page
 * made every user answer for themselves.
 *
 * "Email me a link instead" is here because having a password shouldn't trap
 * you into remembering it. It posts to the same magic-link action the other
 * branch uses.
 */
export default async function PasswordStepPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; next?: string; error?: string }>;
}) {
  const { email, next, error } = await searchParams;
  if (!email) redirect("/login");

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-1 text-xl font-semibold">Enter your password</h1>
      {/* "Not you?" on its own row rather than trailing the sentence: inline in
          body text it's a ~17px target, and it's the only way back to the front
          door from here. */}
      <p className="text-sm text-stone-500">
        Signing in as <strong className="font-medium text-stone-700">{email}</strong>.
      </p>
      <a
        href={`/login?next=${encodeURIComponent(next ?? "/trips")}`}
        className="link mb-4 inline-flex min-h-11 items-center text-sm"
      >
        Not you?
      </a>

      {error && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      <form action={passwordLogin} className="space-y-3">
        {/* autoComplete="username" on the hidden carrier: password managers
            key a saved credential on a username field being present in the
            same form, and splitting sign-in across two pages takes the visible
            one away. */}
        <input type="hidden" name="email" value={email} autoComplete="username" />
        <input type="hidden" name="next" value={next ?? "/trips"} />
        <input
          type="password"
          name="password"
          required
          autoFocus
          autoComplete="current-password"
          placeholder="Password"
          className="input"
        />
        <button type="submit" className="btn-primary w-full">
          Sign in
        </button>
      </form>

      <form action={requestMagicLink} className="mt-4">
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="next" value={next ?? "/trips"} />
        <button
          type="submit"
          className="inline-flex min-h-11 w-full items-center justify-center text-sm text-stone-500 underline hover:text-stone-700"
        >
          Email me a sign-in link instead
        </button>
      </form>
    </div>
  );
}

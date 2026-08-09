import { startSignIn } from "./actions.ts";
import { emailDeliveryConfigured } from "@/lib/email.ts";

/**
 * One field. The page used to stack a magic-link form and a password form,
 * divided by "or, if you've set one" -- two identical email boxes, and a
 * question only the server could actually answer. startSignIn answers it and
 * routes accordingly.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-1 text-xl font-semibold">Sign in</h1>
      <p className="mb-6 text-sm text-stone-500">
        {emailDeliveryConfigured()
          ? "New or returning, same box: enter your email and we'll take it from there. No password needed unless you've set one."
          : "No email provider is configured, so sign-in links are printed to the server console."}
      </p>

      {error && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      <form action={startSignIn} className="space-y-3">
        <input type="hidden" name="next" value={next ?? "/trips"} />
        <input
          type="email"
          name="email"
          required
          autoFocus
          autoComplete="email"
          placeholder="you@example.com"
          className="input"
        />
        <button type="submit" className="btn-primary w-full">
          Continue
        </button>
      </form>
    </div>
  );
}

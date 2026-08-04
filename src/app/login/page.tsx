import { requestMagicLink, passwordLogin } from "./actions.ts";
import { emailDeliveryConfigured } from "@/lib/email.ts";

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
          ? "We'll email you a sign-in link — no password needed."
          : "No email provider is configured, so the sign-in link will be printed to the server console."}
      </p>

      {error && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      <form action={requestMagicLink} className="space-y-3">
        <input type="hidden" name="next" value={next ?? "/trips"} />
        <input
          type="email"
          name="email"
          required
          placeholder="you@example.com"
          className="input"
        />
        <button type="submit" className="btn-primary w-full">
          Send sign-in link
        </button>
      </form>

      <div className="my-6 flex items-center gap-3 text-xs text-stone-400">
        <div className="h-px flex-1 bg-stone-200" />
        or, if you've set one
        <div className="h-px flex-1 bg-stone-200" />
      </div>

      <form action={passwordLogin} className="space-y-3">
        <input type="hidden" name="next" value={next ?? "/trips"} />
        <input
          type="email"
          name="email"
          required
          placeholder="you@example.com"
          className="input"
        />
        <input type="password" name="password" required placeholder="Password" className="input" />
        <button type="submit" className="btn-secondary w-full">
          Sign in with password
        </button>
      </form>
    </div>
  );
}

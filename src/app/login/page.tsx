import { requestMagicLink } from "./actions.ts";
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
          className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
        />
        <button
          type="submit"
          className="w-full rounded-md bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700"
        >
          Send sign-in link
        </button>
      </form>
    </div>
  );
}

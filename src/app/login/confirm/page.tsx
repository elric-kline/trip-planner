import { redirect } from "next/navigation";
import { confirmSignIn } from "./actions.ts";

/**
 * Deliberately does nothing with the token itself on render — this page is a
 * plain GET with no side effects. Email providers and corporate security
 * gateways routinely auto-visit links in incoming mail to scan them; if
 * loading this page redeemed the token, that automated visit would silently
 * burn a one-time login link before its owner ever clicked it. Redeeming
 * only happens in confirmSignIn, which requires an actual form POST — a real
 * click, not a bot's GET.
 */
export default async function ConfirmSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string }>;
}) {
  const { token, next } = await searchParams;
  if (!token) redirect(`/login?error=${encodeURIComponent("Missing sign-in token.")}`);

  return (
    <div className="mx-auto max-w-sm text-center">
      <h1 className="mb-2 text-xl font-semibold">Finish signing in</h1>
      <p className="mb-6 text-sm text-stone-500">
        Confirm below to sign in to AgreeMobile. This link works once, so it won't
        be redeemed until you click.
      </p>

      <form action={confirmSignIn}>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="next" value={next ?? "/trips"} />
        <button type="submit" className="btn-primary w-full">
          Confirm sign-in
        </button>
      </form>
    </div>
  );
}

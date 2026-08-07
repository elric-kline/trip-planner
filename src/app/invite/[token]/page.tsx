import { getCurrentUser } from "@/lib/auth.ts";
import { acceptInviteAction } from "./actions.ts";

export default async function AcceptInvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  const user = await getCurrentUser();

  return (
    <div className="mx-auto max-w-sm text-center">
      <h1 className="mb-2 text-xl font-semibold">You&apos;re invited</h1>

      {error && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {user ? (
        <>
          <p className="mb-4 text-sm text-stone-500">Signed in as {user.email}.</p>
          <form action={acceptInviteAction.bind(null, token)}>
            <button className="btn-primary w-full">Join the trip</button>
          </form>
        </>
      ) : (
        <>
          <p className="mb-4 text-sm text-stone-500">Sign in to accept this invite.</p>
          <a href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`} className="btn-primary block">
            Sign in
          </a>
        </>
      )}
    </div>
  );
}

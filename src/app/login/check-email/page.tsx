export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const { email } = await searchParams;
  return (
    <div className="mx-auto max-w-sm text-center">
      <h1 className="mb-2 text-xl font-semibold">Check your email</h1>
      <p className="text-sm text-stone-500">
        We sent a sign-in link to <strong>{email}</strong>. Open it on this device to continue.
      </p>
    </div>
  );
}

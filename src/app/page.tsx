import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth.ts";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (user) redirect("/trips");

  return (
    <div className="mx-auto max-w-lg py-12 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">
        Plan trips your group actually agrees on.
      </h1>
      <p className="mt-4 text-stone-600">
        Pitch ideas, vote, and lock in an itinerary together — then keep it as a
        shared journal once you're there.
      </p>
      <a href="/login" className="btn-primary mt-8 inline-block">
        Sign in
      </a>
    </div>
  );
}

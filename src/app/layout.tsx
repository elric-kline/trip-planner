import type { Metadata } from "next";
import "./globals.css";
import { getCurrentUser, signOut } from "@/lib/auth.ts";

export const metadata: Metadata = {
  title: "Trip Planner",
  description: "Plan a group trip together, then keep it as a shared journal.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-stone-200 bg-white">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
            <a href="/trips" className="font-semibold tracking-tight">
              Trip Planner
            </a>
            {user ? (
              <form
                action={async () => {
                  "use server";
                  await signOut();
                }}
              >
                <span className="mr-3 text-sm text-stone-500">{user.email}</span>
                <button className="text-sm text-stone-500 underline hover:text-stone-800">
                  Sign out
                </button>
              </form>
            ) : (
              <a href="/login" className="text-sm text-stone-500 underline">
                Sign in
              </a>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}

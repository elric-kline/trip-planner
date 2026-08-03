import type { Metadata } from "next";
import "./globals.css";
import { getCurrentUser, signOut } from "@/lib/auth.ts";

export const metadata: Metadata = {
  title: {
    default: "AgreeMobile",
    template: "%s · AgreeMobile",
  },
  description:
    "Align on where you're going and what you're doing, then keep the trip as a shared journal.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-stone-200 bg-white">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
            <a href="/trips" className="text-lg font-semibold tracking-tight">
              <span className="text-teal-700">Agree</span>
              <span className="text-stone-900">Mobile</span>
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

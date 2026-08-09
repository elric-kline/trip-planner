import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { getCurrentUser, signOut } from "@/lib/auth.ts";
import { Logo } from "@/components/logo.tsx";
import { displayName } from "@/lib/display-name.ts";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "AgreeMobile",
    template: "%s · AgreeMobile",
  },
  description:
    "Align on where you're going and what you're doing, and see who's actually in before anything gets locked.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable}`}>
      <body className="min-h-screen">
        <header className="border-b border-stone-200 bg-white">
          {/* py-2 rather than py-3: every child below now carries the 44px
              minimum touch height itself, so the old vertical padding would
              only have made the header taller without making anything easier
              to hit. */}
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-2">
            <a href="/trips" className="inline-flex min-h-11 items-center">
              <Logo />
            </a>
            {user ? (
              <div className="flex min-w-0 items-center gap-3 text-sm">
                <a
                  href="/profile"
                  className="inline-flex min-h-11 min-w-0 items-center truncate text-stone-500 underline hover:text-route-700"
                >
                  {displayName(user)}
                </a>
                {/* shrink-0 on the form, not just the button inside it: the
                    form is the flex item, so without it a long name squeezes
                    this column and "Sign out" wraps to two lines. */}
                <form
                  className="shrink-0"
                  action={async () => {
                    "use server";
                    await signOut();
                  }}
                >
                  <button className="inline-flex min-h-11 shrink-0 items-center text-stone-500 underline hover:text-route-700">
                    Sign out
                  </button>
                </form>
              </div>
            ) : (
              <a href="/login" className="link inline-flex min-h-11 items-center text-sm">
                Sign in
              </a>
            )}
          </div>
          <div className="road-rule" />
        </header>
        <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}

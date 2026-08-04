import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { getCurrentUser, signOut } from "@/lib/auth.ts";
import { Logo } from "@/components/logo.tsx";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AgreeMobile",
  description: "Get your friends aligned on the trip itinerary, one stop at a time.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable}`}>
      <body className="min-h-screen">
        <header className="border-b border-stone-200 bg-white">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
            <a href="/trips">
              <Logo />
            </a>
            {user ? (
              <form
                action={async () => {
                  "use server";
                  await signOut();
                }}
              >
                <span className="mr-3 text-sm text-stone-500">{user.email}</span>
                <button className="text-sm text-stone-500 underline hover:text-route-700">
                  Sign out
                </button>
              </form>
            ) : (
              <a href="/login" className="link text-sm">
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

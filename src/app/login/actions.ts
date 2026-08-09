"use server";

import { redirect } from "next/navigation";
import type { Route } from "next";
import { createLoginToken, hasPassword, verifyPasswordLogin } from "@/lib/auth.ts";
import { sendMagicLink } from "@/lib/email.ts";
import { absoluteOrigin } from "@/lib/url.ts";

/**
 * The single front door. The page used to stack two forms -- magic link, and
 * password -- divided by "or, if you've set one", which asked every user to
 * remember whether they'd ever created a password here. Most won't, and it's
 * not their job to know.
 *
 * One field now: the server knows whether that address has a password, so it
 * routes to the step that applies. Anyone can still choose the other route
 * from the step they land on.
 */
export async function startSignIn(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const next = String(formData.get("next") ?? "") || "/trips";
  if (!email || !email.includes("@")) {
    redirect(`/login?error=${encodeURIComponent("Enter a valid email address.")}&next=${encodeURIComponent(next)}`);
  }

  if (await hasPassword(email)) {
    redirect(`/login/password?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`);
  }

  // No password on file -- and an address with no account at all lands here
  // too, since redeeming a link is also how somebody signs up.
  await requestMagicLink(formData);
}

export async function requestMagicLink(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const next = String(formData.get("next") ?? "") || "/trips";
  if (!email || !email.includes("@")) {
    redirect(`/login?error=${encodeURIComponent("Enter a valid email address.")}&next=${encodeURIComponent(next)}`);
  }

  const token = await createLoginToken(email);
  const origin = await absoluteOrigin();
  const url = `${origin}/login/confirm?token=${token}&next=${encodeURIComponent(next)}`;

  try {
    await sendMagicLink(email, url);
  } catch (err) {
    console.error("[login] failed to send magic link:", err);
    redirect(
      `/login?error=${encodeURIComponent("Couldn't send the sign-in email — try again in a moment.")}&next=${encodeURIComponent(next)}`,
    );
  }

  redirect(`/login/check-email?email=${encodeURIComponent(email)}`);
}

export async function passwordLogin(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "") || "/trips";

  const user = email && password ? await verifyPasswordLogin(email, password) : null;
  if (!user) {
    // Back to the password step rather than the start, so a typo costs one
    // field rather than the whole flow. "Password" alone, not "email or
    // password" -- the address is already known good by the time you're here.
    redirect(
      `/login/password?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}&error=${encodeURIComponent("That password didn't match.")}`,
    );
  }

  // `next` comes from a query param, not a route the app declares statically,
  // so typedRoutes can't verify it — this is Next's documented escape hatch
  // for exactly that case.
  redirect(next as Route);
}

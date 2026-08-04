"use server";

import { redirect } from "next/navigation";
import type { Route } from "next";
import { createLoginToken, verifyPasswordLogin } from "@/lib/auth.ts";
import { sendMagicLink } from "@/lib/email.ts";
import { absoluteOrigin } from "@/lib/url.ts";

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
    redirect(
      `/login?error=${encodeURIComponent("Wrong email or password.")}&next=${encodeURIComponent(next)}`,
    );
  }

  // `next` comes from a query param, not a route the app declares statically,
  // so typedRoutes can't verify it — this is Next's documented escape hatch
  // for exactly that case.
  redirect(next as Route);
}

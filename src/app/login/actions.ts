"use server";

import { redirect } from "next/navigation";
import { createLoginToken } from "@/lib/auth.ts";
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
  const url = `${origin}/api/auth/verify?token=${token}&next=${encodeURIComponent(next)}`;

  await sendMagicLink(email, url);

  redirect(`/login/check-email?email=${encodeURIComponent(email)}`);
}

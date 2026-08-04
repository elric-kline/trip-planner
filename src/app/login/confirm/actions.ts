"use server";

import { redirect } from "next/navigation";
import type { Route } from "next";
import { redeemLoginToken } from "@/lib/auth.ts";

export async function confirmSignIn(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const next = String(formData.get("next") ?? "") || "/trips";

  if (!token) {
    redirect(`/login?error=${encodeURIComponent("Missing sign-in token.")}`);
  }

  const result = await redeemLoginToken(token);
  if (!result) {
    redirect(
      `/login?error=${encodeURIComponent("That sign-in link is invalid or has expired.")}`,
    );
  }

  if (result.needsPassword) {
    redirect(`/login/set-password?next=${encodeURIComponent(next)}`);
  }

  // `next` comes from a query param, not a route the app declares statically,
  // so typedRoutes can't verify it — this is Next's documented escape hatch
  // for exactly that case.
  redirect(next as Route);
}

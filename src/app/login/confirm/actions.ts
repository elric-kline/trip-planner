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

  // Deliberately ignores `result.needsPassword`. This used to detour every
  // passwordless sign-in through "Create a password" -- which is a settings
  // change, not a step in getting where you were going, and it landed most
  // often on somebody who had just clicked a trip invite. It also contradicts
  // the front door: sign-in asks one question now precisely because whether
  // you have a password is not the user's problem. /login/set-password is
  // still there, reachable from Profile, for anyone who wants one.
  //
  // `next` comes from a query param, not a route the app declares statically,
  // so typedRoutes can't verify it — this is Next's documented escape hatch
  // for exactly that case.
  redirect(next as Route);
}

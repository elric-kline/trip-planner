"use server";

import { redirect } from "next/navigation";
import type { Route } from "next";
import { requireUser, setPassword } from "@/lib/auth.ts";

export async function submitPassword(formData: FormData): Promise<void> {
  const user = await requireUser();
  const next = String(formData.get("next") ?? "") || "/trips";
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  const fail = (message: string) => {
    redirect(
      `/login/set-password?next=${encodeURIComponent(next)}&error=${encodeURIComponent(message)}`,
    );
  };

  if (password !== confirm) {
    fail("Those passwords don't match.");
    return;
  }

  try {
    await setPassword(user.id, password);
  } catch (err) {
    fail(err instanceof Error ? err.message : "Something went wrong.");
    return;
  }

  // `next` comes from a query param, not a route the app declares statically,
  // so typedRoutes can't verify it — this is Next's documented escape hatch
  // for exactly that case.
  redirect(next as Route);
}

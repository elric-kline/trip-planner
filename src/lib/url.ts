import { headers } from "next/headers";
import { resolveOrigin } from "./origin.ts";

/**
 * Absolute origin for links embedded outside the current request — email,
 * and invite links shown on a page but meant to be pasted elsewhere.
 *
 * Set APP_URL once agreemobile.com is connected so every generated link uses
 * it. Falling back to request headers keeps local dev working with no env
 * var at all. The actual decision logic lives in origin.ts, which has no
 * `next/headers` import and so is unit-testable without a request context.
 */
export async function absoluteOrigin(): Promise<string> {
  const h = await headers();
  return resolveOrigin({
    appUrl: process.env.APP_URL,
    isProduction: process.env.NODE_ENV === "production",
    forwardedProto: h.get("x-forwarded-proto") ?? undefined,
    forwardedHost: h.get("x-forwarded-host") ?? undefined,
    host: h.get("host") ?? undefined,
  });
}

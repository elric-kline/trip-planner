import { NextRequest, NextResponse } from "next/server";
import { redeemLoginToken } from "@/lib/auth.ts";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  const next = request.nextUrl.searchParams.get("next") || "/trips";

  if (!token) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent("Missing sign-in token.")}`, request.url),
    );
  }

  const result = await redeemLoginToken(token);
  if (!result) {
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent("That sign-in link is invalid or has expired.")}`,
        request.url,
      ),
    );
  }

  if (result.needsPassword) {
    return NextResponse.redirect(
      new URL(`/login/set-password?next=${encodeURIComponent(next)}`, request.url),
    );
  }

  return NextResponse.redirect(new URL(next, request.url));
}

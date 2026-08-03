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

  const user = await redeemLoginToken(token);
  if (!user) {
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent("That sign-in link is invalid or has expired.")}`,
        request.url,
      ),
    );
  }

  return NextResponse.redirect(new URL(next, request.url));
}

import { getCurrentUser } from "@/lib/auth.ts";
import { inferCuisineAndDietary } from "@/lib/cuisine-inference.ts";

/**
 * Auth-gated the same way as the /api/places/* proxies — this one's
 * arguably more important to gate, since it burns real LLM + web-search
 * spend per call rather than a cheap Places lookup.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ result: null }, { status: 401 });

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name : "";
  const address = typeof body?.address === "string" ? body.address : null;
  if (!name.trim()) return Response.json({ result: null }, { status: 400 });

  const result = await inferCuisineAndDietary(name, address);
  return Response.json({ result });
}

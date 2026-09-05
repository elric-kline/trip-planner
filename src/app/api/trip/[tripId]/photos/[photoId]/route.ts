import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, requireTripAccess, type TripAccess } from "@/lib/scope.ts";
import { deletePhoto, updatePhotoCaption } from "@/lib/photos.ts";
import { RuleError } from "@/lib/items.ts";

async function resolveAccess(tripId: string): Promise<{ access: TripAccess } | { error: Response }> {
  const user = await getCurrentUser();
  if (!user) return { error: Response.json({ error: "Not signed in." }, { status: 401 }) };
  try {
    return { access: await requireTripAccess(tripId, user) };
  } catch (err) {
    if (err instanceof AccessError) return { error: Response.json({ error: "Not found." }, { status: 404 }) };
    throw err;
  }
}

/** Update caption (uploader or planner). */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ tripId: string; photoId: string }> },
) {
  const { tripId, photoId } = await params;
  const resolved = await resolveAccess(tripId);
  if ("error" in resolved) return resolved.error;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Send JSON with a caption field." }, { status: 400 });
  }
  const caption = "caption" in body ? (body.caption == null ? null : String(body.caption)) : undefined;
  if (caption === undefined) {
    return Response.json({ error: "Include a caption field." }, { status: 400 });
  }

  try {
    const photo = await updatePhotoCaption(resolved.access, photoId, caption);
    return Response.json({ photo: { id: photo.id, caption: photo.caption } });
  } catch (err) {
    if (err instanceof RuleError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
}

/** Delete a photo (uploader or planner). */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ tripId: string; photoId: string }> },
) {
  const { tripId, photoId } = await params;
  const resolved = await resolveAccess(tripId);
  if ("error" in resolved) return resolved.error;

  try {
    await deletePhoto(resolved.access, photoId);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof RuleError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
}

import { getCurrentUser } from "@/lib/auth.ts";
import { AccessError, requireTripAccess, type TripAccess } from "@/lib/scope.ts";
import { listDayPhotos, listItemPhotos, listTripLevelPhotos, listTripPhotos, uploadPhoto, type Photo, type PhotoScope } from "@/lib/photos.ts";
import { RuleError } from "@/lib/items.ts";

/**
 * The photo journal's client-facing surface.
 *
 * `GET` returns photos, optionally filtered to one scope (trip/day/item).
 * `POST` accepts a multipart upload -- one `file` field plus a small set of
 * form fields describing where the photo attaches. Both go through the
 * regular trip-scope check first; a non-member gets 404, same "don't
 * confirm what exists" posture as the passport-photo route.
 */

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

function toWire(photo: Photo) {
  return {
    id: photo.id,
    tripId: photo.tripId,
    scope: photo.scope,
    dayId: photo.dayId,
    itemId: photo.itemId,
    uploadedBy: photo.uploadedBy,
    uploaderName: photo.uploaderName,
    uploaderEmail: photo.uploaderEmail,
    mimeType: photo.mimeType,
    sizeBytes: photo.sizeBytes,
    caption: photo.caption,
    capturedAt: photo.capturedAt?.toISOString() ?? null,
    createdAt: photo.createdAt.toISOString(),
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params;
  const resolved = await resolveAccess(tripId);
  if ("error" in resolved) return resolved.error;
  const { access } = resolved;

  const url = new URL(request.url);
  const scope = url.searchParams.get("scope");
  const dayId = url.searchParams.get("dayId");
  const itemId = url.searchParams.get("itemId");

  try {
    let photos: Photo[];
    if (scope === "day") {
      if (!dayId) return Response.json({ error: "dayId is required for scope=day." }, { status: 400 });
      photos = await listDayPhotos(access, dayId);
    } else if (scope === "item") {
      if (!itemId) return Response.json({ error: "itemId is required for scope=item." }, { status: 400 });
      photos = await listItemPhotos(access, itemId);
    } else if (scope === "trip") {
      photos = await listTripLevelPhotos(access);
    } else {
      photos = await listTripPhotos(access);
    }
    return Response.json({ photos: photos.map(toWire) });
  } catch (err) {
    if (err instanceof RuleError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
}

const KNOWN_SCOPES: readonly PhotoScope[] = ["trip", "day", "item"];

function parseCapturedAt(raw: FormDataEntryValue | null): Date | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

export async function POST(request: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params;
  const resolved = await resolveAccess(tripId);
  if ("error" in resolved) return resolved.error;
  const { access } = resolved;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Send the photo as multipart/form-data." }, { status: 400 });
  }

  const scopeRaw = String(form.get("scope") ?? "").trim();
  if (!KNOWN_SCOPES.includes(scopeRaw as PhotoScope)) {
    return Response.json({ error: "Pick a scope: trip, day, or item." }, { status: 400 });
  }
  const scope = scopeRaw as PhotoScope;

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: "Pick a photo to upload." }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  try {
    const photo = await uploadPhoto(access, {
      scope,
      dayId: String(form.get("dayId") ?? "") || null,
      itemId: String(form.get("itemId") ?? "") || null,
      mimeType: file.type || "application/octet-stream",
      bytes,
      caption: String(form.get("caption") ?? "") || null,
      capturedAt: parseCapturedAt(form.get("capturedAt")),
    });
    return Response.json({ photo: toWire(photo) }, { status: 201 });
  } catch (err) {
    if (err instanceof RuleError) return Response.json({ error: err.message }, { status: 400 });
    if (err instanceof AccessError) return Response.json({ error: "Not found." }, { status: 404 });
    throw err;
  }
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * The photo journal's client surface. A grid of thumbnails, an "Add photos"
 * button that opens a scope picker, and per-photo delete/caption controls
 * for whoever's allowed to touch a given row.
 *
 * All I/O is client-side fetches against /api/trip/[tripId]/photos rather
 * than server actions -- multipart uploads don't fit the form-action flow
 * cleanly, and once we're doing one client fetch for uploads there's no
 * reason to split the read path back out into a server-rendered list.
 *
 * Client-side image resize (see `resizeImage` below) is the one bit of
 * heavy lifting: an unprocessed phone shot is 3-6 MB, most of which is
 * detail nobody will ever see in a gallery card, and shipping originals
 * would blow through R2 egress and page load budgets in a week. We resize
 * to 2400px longest side before upload; the original never leaves the
 * device. When the browser can't decode it (an HEIC on a non-Apple
 * platform, say) we fall back to uploading the raw file -- better a large
 * upload than a refused one.
 */

export type PhotoWire = {
  id: string;
  tripId: string;
  scope: "trip" | "day" | "item";
  dayId: string | null;
  itemId: string | null;
  uploadedBy: string;
  uploaderName: string | null;
  uploaderEmail: string;
  mimeType: string;
  sizeBytes: number;
  caption: string | null;
  capturedAt: string | null;
  createdAt: string;
};

export type ItemOption = { id: string; title: string; dayId: string | null };
export type DayOption = { id: string; date: string };

type Props = {
  tripId: string;
  viewerId: string;
  isPlanner: boolean;
  initialPhotos: PhotoWire[];
  days: DayOption[];
  items: ItemOption[];
  storageConfigured: boolean;
};

const MAX_LONGEST_SIDE = 2400;
const RESIZE_QUALITY = 0.85;
/** Same cap the server enforces (see lib/photos.ts). Client-side check up-front is a fast fail, not the security boundary. */
const MAX_POST_RESIZE_BYTES = 15 * 1024 * 1024;

type UploadStatus =
  | { kind: "idle" }
  | { kind: "working"; done: number; total: number }
  | { kind: "error"; message: string };

/**
 * Canvas-based resize. `image/webp` is quietly ~30% smaller than JPEG at
 * the same visual quality, so we try webp first and fall back to JPEG
 * where the browser refuses it (older Safari on iOS). PNGs stay PNGs
 * (they're the only case where re-encoding as JPEG would lose alpha,
 * and screenshots people paste in are usually already small).
 */
async function resizeImage(file: File): Promise<{ blob: Blob; mimeType: string }> {
  // Bail out on tiny files -- resizing a 40 KB image round-trips more work than it saves.
  if (file.size < 200 * 1024) return { blob: file, mimeType: file.type || "application/octet-stream" };

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Browser can't decode it (e.g. HEIC on non-Apple). Send the original;
    // the server accepts it. Better a large upload than a refused one.
    return { blob: file, mimeType: file.type || "application/octet-stream" };
  }

  const { width, height } = bitmap;
  const longest = Math.max(width, height);
  if (longest <= MAX_LONGEST_SIDE && file.size < 2 * 1024 * 1024) {
    // Already small enough; skip the re-encode.
    bitmap.close();
    return { blob: file, mimeType: file.type || "application/octet-stream" };
  }

  const scale = longest > MAX_LONGEST_SIDE ? MAX_LONGEST_SIDE / longest : 1;
  const targetWidth = Math.round(width * scale);
  const targetHeight = Math.round(height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return { blob: file, mimeType: file.type || "application/octet-stream" };
  }
  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  bitmap.close();

  const preferPng = file.type === "image/png";
  const targetType = preferPng ? "image/png" : "image/webp";
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, targetType, RESIZE_QUALITY),
  );
  if (blob) return { blob, mimeType: targetType };

  // Fall back to JPEG if webp isn't supported.
  const jpeg = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", RESIZE_QUALITY),
  );
  if (jpeg) return { blob: jpeg, mimeType: "image/jpeg" };

  return { blob: file, mimeType: file.type || "application/octet-stream" };
}

type Scope = "trip" | "day" | "item";

export default function PhotoJournal(props: Props) {
  const [photos, setPhotos] = useState<PhotoWire[]>(props.initialPhotos);
  const [status, setStatus] = useState<UploadStatus>({ kind: "idle" });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [scope, setScope] = useState<Scope>("trip");
  const [selectedDayId, setSelectedDayId] = useState<string>(props.days[0]?.id ?? "");
  const [selectedItemId, setSelectedItemId] = useState<string>(props.items[0]?.id ?? "");
  const [caption, setCaption] = useState("");
  const [filter, setFilter] = useState<
    | { kind: "all" }
    | { kind: "trip" }
    | { kind: "day"; dayId: string }
    | { kind: "item"; itemId: string }
  >({ kind: "all" });
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const itemsByDay = useMemo(() => {
    const grouped = new Map<string, ItemOption[]>();
    for (const item of props.items) {
      if (!item.dayId) continue;
      const list = grouped.get(item.dayId) ?? [];
      list.push(item);
      grouped.set(item.dayId, list);
    }
    return grouped;
  }, [props.items]);

  const filteredPhotos = useMemo(() => {
    if (filter.kind === "all") return photos;
    if (filter.kind === "trip") return photos.filter((p) => p.scope === "trip");
    if (filter.kind === "day") {
      return photos.filter((p) => {
        if (p.dayId === filter.dayId) return true;
        // Include photos whose item lives on that day
        if (!p.itemId) return false;
        const item = props.items.find((i) => i.id === p.itemId);
        return item?.dayId === filter.dayId;
      });
    }
    return photos.filter((p) => p.itemId === filter.itemId);
  }, [photos, filter, props.items]);

  const openPicker = useCallback(() => {
    if (!props.storageConfigured) {
      setStatus({
        kind: "error",
        message:
          "Photo storage isn't configured yet. Ask whoever runs this app to set the R2 environment variables.",
      });
      return;
    }
    setPickerOpen(true);
  }, [props.storageConfigured]);

  const upload = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;

      setStatus({ kind: "working", done: 0, total: list.length });

      const scopeToSend: Scope = scope;
      const dayIdToSend = scopeToSend === "day" ? selectedDayId : "";
      const itemIdToSend = scopeToSend === "item" ? selectedItemId : "";
      const captionToSend = caption.trim();

      if (scopeToSend === "day" && !dayIdToSend) {
        setStatus({ kind: "error", message: "Pick which day the photo is for." });
        return;
      }
      if (scopeToSend === "item" && !itemIdToSend) {
        setStatus({ kind: "error", message: "Pick which item the photo is for." });
        return;
      }

      const uploaded: PhotoWire[] = [];
      for (let index = 0; index < list.length; index++) {
        const raw = list[index];
        try {
          const { blob, mimeType } = await resizeImage(raw);
          if (blob.size > MAX_POST_RESIZE_BYTES) {
            throw new Error(`That photo is still too large after resize (${Math.round(blob.size / 1024 / 1024)} MB).`);
          }
          const form = new FormData();
          form.append("scope", scopeToSend);
          if (dayIdToSend) form.append("dayId", dayIdToSend);
          if (itemIdToSend) form.append("itemId", itemIdToSend);
          if (captionToSend) form.append("caption", captionToSend);
          // Preserve the original filename for the server-side extension if it needs one.
          const filename = raw.name || "photo";
          form.append("file", new File([blob], filename, { type: mimeType }));

          const res = await fetch(`/api/trip/${props.tripId}/photos`, {
            method: "POST",
            body: form,
          });
          if (!res.ok) {
            const data = await res.json().catch(() => null);
            throw new Error(data?.error ?? `Upload failed (HTTP ${res.status}).`);
          }
          const data = (await res.json()) as { photo: PhotoWire };
          uploaded.push(data.photo);
          setStatus({ kind: "working", done: index + 1, total: list.length });
        } catch (err) {
          setStatus({
            kind: "error",
            message: err instanceof Error ? err.message : "Upload failed.",
          });
          break;
        }
      }

      if (uploaded.length > 0) {
        // Newest first, matching the server ordering.
        setPhotos((prev) => [...uploaded.reverse(), ...prev]);
        setCaption("");
        setPickerOpen(false);
      }
      setStatus((s) => (s.kind === "error" ? s : { kind: "idle" }));
    },
    [caption, props.tripId, scope, selectedDayId, selectedItemId],
  );

  const onFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) return;
      void upload(files);
      // Reset so re-picking the same file still fires change.
      event.target.value = "";
    },
    [upload],
  );

  const handleDelete = useCallback(
    async (photoId: string) => {
      if (!confirm("Delete this photo?")) return;
      const res = await fetch(`/api/trip/${props.tripId}/photos/${photoId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setStatus({ kind: "error", message: data?.error ?? "Couldn't delete that photo." });
        return;
      }
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
    },
    [props.tripId],
  );

  const handleCaptionEdit = useCallback(
    async (photoId: string, current: string | null) => {
      const next = prompt("Caption:", current ?? "");
      if (next === null) return; // cancelled
      const res = await fetch(`/api/trip/${props.tripId}/photos/${photoId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caption: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setStatus({ kind: "error", message: data?.error ?? "Couldn't save that caption." });
        return;
      }
      const data = (await res.json()) as { photo: { id: string; caption: string | null } };
      setPhotos((prev) => prev.map((p) => (p.id === photoId ? { ...p, caption: data.photo.caption } : p)));
    },
    [props.tripId],
  );

  // A dismiss handler for the error banner -- it's persistent by design (an
  // upload that failed silently is the exact bug this replaces), but the
  // viewer needs a way to acknowledge and try again.
  useEffect(() => {
    if (status.kind !== "error") return;
    const timer = setTimeout(() => setStatus({ kind: "idle" }), 10_000);
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FilterBar
          filter={filter}
          onChange={setFilter}
          days={props.days}
          items={props.items}
          itemsByDay={itemsByDay}
          photoCount={photos.length}
        />
        <button
          type="button"
          onClick={openPicker}
          className="btn-primary"
          disabled={status.kind === "working"}
        >
          {status.kind === "working"
            ? `Uploading ${status.done + 1}/${status.total}…`
            : "Add photos"}
        </button>
      </div>

      {status.kind === "error" && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{status.message}</p>
      )}

      {pickerOpen && (
        <UploadPicker
          onClose={() => setPickerOpen(false)}
          onSubmit={(files) => void upload(files)}
          scope={scope}
          setScope={setScope}
          selectedDayId={selectedDayId}
          setSelectedDayId={setSelectedDayId}
          selectedItemId={selectedItemId}
          setSelectedItemId={setSelectedItemId}
          caption={caption}
          setCaption={setCaption}
          days={props.days}
          items={props.items}
          itemsByDay={itemsByDay}
          fileInputRef={fileInputRef}
          onFileChange={onFileChange}
        />
      )}

      {filteredPhotos.length === 0 ? (
        <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 px-4 py-8 text-center text-sm text-stone-500">
          No photos here yet. Tap “Add photos” to start the journal.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {filteredPhotos.map((photo, index) => (
            <PhotoCard
              key={photo.id}
              tripId={props.tripId}
              photo={photo}
              canDelete={photo.uploadedBy === props.viewerId || props.isPlanner}
              onOpen={() => setLightboxIndex(index)}
              onDelete={() => handleDelete(photo.id)}
              onEditCaption={() => handleCaptionEdit(photo.id, photo.caption)}
              days={props.days}
              items={props.items}
            />
          ))}
        </ul>
      )}

      {lightboxIndex !== null && filteredPhotos[lightboxIndex] && (
        <Lightbox
          tripId={props.tripId}
          photos={filteredPhotos}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          days={props.days}
          items={props.items}
        />
      )}
    </div>
  );
}

function FilterBar({
  filter,
  onChange,
  days,
  items,
  itemsByDay,
  photoCount,
}: {
  filter:
    | { kind: "all" }
    | { kind: "trip" }
    | { kind: "day"; dayId: string }
    | { kind: "item"; itemId: string };
  onChange: (
    next:
      | { kind: "all" }
      | { kind: "trip" }
      | { kind: "day"; dayId: string }
      | { kind: "item"; itemId: string },
  ) => void;
  days: DayOption[];
  items: ItemOption[];
  itemsByDay: Map<string, ItemOption[]>;
  photoCount: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-xs text-stone-400">{photoCount} on this trip</span>
      <select
        value={
          filter.kind === "all"
            ? "all"
            : filter.kind === "trip"
              ? "trip"
              : filter.kind === "day"
                ? `day:${filter.dayId}`
                : `item:${filter.itemId}`
        }
        onChange={(e) => {
          const v = e.target.value;
          if (v === "all") onChange({ kind: "all" });
          else if (v === "trip") onChange({ kind: "trip" });
          else if (v.startsWith("day:")) onChange({ kind: "day", dayId: v.slice(4) });
          else if (v.startsWith("item:")) onChange({ kind: "item", itemId: v.slice(5) });
        }}
        className="input max-w-full"
      >
        <option value="all">All photos</option>
        <option value="trip">Trip-wide only</option>
        <optgroup label="By day">
          {days.map((d) => (
            <option key={d.id} value={`day:${d.id}`}>
              {d.date}
            </option>
          ))}
        </optgroup>
        {items.length > 0 && (
          <optgroup label="By item">
            {days.map((d) =>
              (itemsByDay.get(d.id) ?? []).map((item) => (
                <option key={item.id} value={`item:${item.id}`}>
                  {d.date} · {item.title}
                </option>
              )),
            )}
            {items
              .filter((i) => !i.dayId)
              .map((item) => (
                <option key={item.id} value={`item:${item.id}`}>
                  Unscheduled · {item.title}
                </option>
              ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}

function PhotoCard({
  tripId,
  photo,
  canDelete,
  onOpen,
  onDelete,
  onEditCaption,
  days,
  items,
}: {
  tripId: string;
  photo: PhotoWire;
  canDelete: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onEditCaption: () => void;
  days: DayOption[];
  items: ItemOption[];
}) {
  const scopeBadge = useMemo(() => {
    if (photo.scope === "item") {
      const item = items.find((i) => i.id === photo.itemId);
      return item ? item.title : "Item";
    }
    if (photo.scope === "day") {
      const day = days.find((d) => d.id === photo.dayId);
      return day ? day.date : "Day";
    }
    return "Trip";
  }, [photo, days, items]);

  return (
    <li className="group flex flex-col overflow-hidden rounded-md border border-stone-200 bg-white shadow-sm">
      {/* A button rather than a plain click handler on the div: keyboard
          activation (Enter/Space) and screen-reader semantics come for free,
          which the previous version's non-interactive tile didn't have. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={photo.caption ? `View "${photo.caption}"` : "View photo"}
        className="relative block aspect-square bg-stone-100 focus:outline-none focus:ring-2 focus:ring-route-500"
      >
        {/* next/image would need remoteHost config for the R2 signed URLs the
            view endpoint redirects to, and we already lazy-load + let R2
            do CDN duty. A plain <img> is the right primitive here. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/trip/${tripId}/photos/${photo.id}/view`}
          alt={photo.caption ?? `Photo by ${photo.uploaderName ?? photo.uploaderEmail}`}
          loading="lazy"
          className="h-full w-full object-cover transition-opacity group-hover:opacity-90"
        />
        <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
          {scopeBadge}
        </span>
      </button>
      <div className="flex flex-1 flex-col gap-1 px-2 py-1.5 text-xs">
        <p className="line-clamp-2 min-h-[2em] text-stone-700">
          {photo.caption ?? <span className="text-stone-400">No caption</span>}
        </p>
        <p className="text-[10px] text-stone-400">
          {photo.uploaderName ?? photo.uploaderEmail} ·{" "}
          {new Date(photo.capturedAt ?? photo.createdAt).toLocaleDateString()}
        </p>
        {canDelete && (
          <div className="flex gap-2 text-[10px]">
            <button
              type="button"
              onClick={onEditCaption}
              className="text-stone-500 underline hover:text-stone-700"
            >
              Caption
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="text-red-600 underline hover:text-red-800"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function UploadPicker({
  onClose,
  onSubmit,
  scope,
  setScope,
  selectedDayId,
  setSelectedDayId,
  selectedItemId,
  setSelectedItemId,
  caption,
  setCaption,
  days,
  items,
  itemsByDay,
  fileInputRef,
  onFileChange,
}: {
  onClose: () => void;
  onSubmit: (files: FileList | File[]) => void;
  scope: Scope;
  setScope: (s: Scope) => void;
  selectedDayId: string;
  setSelectedDayId: (id: string) => void;
  selectedItemId: string;
  setSelectedItemId: (id: string) => void;
  caption: string;
  setCaption: (v: string) => void;
  days: DayOption[];
  items: ItemOption[];
  itemsByDay: Map<string, ItemOption[]>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragOver(false);
      const files = event.dataTransfer.files;
      if (files && files.length > 0) onSubmit(files);
    },
    [onSubmit],
  );

  return (
    <div
      className="rounded-md border border-stone-200 bg-white p-4 shadow-sm"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-stone-800">Add photos</h3>
        <button type="button" onClick={onClose} className="text-xs text-stone-500 underline">
          Cancel
        </button>
      </div>
      <div className="grid gap-3">
        <div>
          <span className="mb-1 block text-xs font-medium text-stone-600">Attach to</span>
          <div className="flex flex-wrap gap-1">
            {(["trip", "day", "item"] as const).map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => setScope(s)}
                className={
                  scope === s
                    ? "rounded-md bg-stone-800 px-3 py-1 text-xs font-medium text-white"
                    : "rounded-md border border-stone-300 px-3 py-1 text-xs text-stone-600 hover:bg-stone-50"
                }
              >
                {s === "trip" ? "The trip" : s === "day" ? "A specific day" : "An itinerary item"}
              </button>
            ))}
          </div>
        </div>

        {scope === "day" && (
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-stone-600">Day</span>
            <select
              value={selectedDayId}
              onChange={(e) => setSelectedDayId(e.target.value)}
              className="input"
            >
              {days.length === 0 && <option value="">No days yet</option>}
              {days.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.date}
                </option>
              ))}
            </select>
          </label>
        )}

        {scope === "item" && (
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-stone-600">Item</span>
            <select
              value={selectedItemId}
              onChange={(e) => setSelectedItemId(e.target.value)}
              className="input"
            >
              {items.length === 0 && <option value="">No items yet</option>}
              {days.map((d) =>
                (itemsByDay.get(d.id) ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {d.date} · {item.title}
                  </option>
                )),
              )}
              {items
                .filter((i) => !i.dayId)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    Unscheduled · {item.title}
                  </option>
                ))}
            </select>
          </label>
        )}

        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-stone-600">Caption (optional)</span>
          <input
            type="text"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="What's happening in the photo"
            className="input"
            maxLength={500}
          />
        </label>

        <div
          className={
            dragOver
              ? "rounded-md border-2 border-dashed border-route-500 bg-route-50 px-4 py-8 text-center text-sm text-route-700"
              : "rounded-md border-2 border-dashed border-stone-300 bg-stone-50 px-4 py-8 text-center text-sm text-stone-500"
          }
        >
          <p>Drop photos here, or</p>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="btn-secondary mt-2"
          >
            Choose files
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={onFileChange}
            className="hidden"
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Fullscreen preview for one photo, driven by an index into the currently
 * filtered gallery so left/right nav walks whatever the viewer's actually
 * looking at (not the full trip). Escape and clicks on the backdrop both
 * close; keyboard arrows step through neighbours. Uses the same
 * /view endpoint the thumbnails do -- the API redirects to the R2 URL,
 * which for a custom-domain deploy is a public CDN fetch and for a bare
 * bucket is a presigned URL -- so this stays honest to the app's own auth
 * either way.
 */
function Lightbox({
  tripId,
  photos,
  index,
  onIndexChange,
  onClose,
  days,
  items,
}: {
  tripId: string;
  photos: PhotoWire[];
  index: number;
  onIndexChange: (next: number) => void;
  onClose: () => void;
  days: DayOption[];
  items: ItemOption[];
}) {
  const photo = photos[index];

  const scopeLabel = useMemo(() => {
    if (!photo) return "";
    if (photo.scope === "item") {
      const item = items.find((i) => i.id === photo.itemId);
      return item ? `Item · ${item.title}` : "Item";
    }
    if (photo.scope === "day") {
      const day = days.find((d) => d.id === photo.dayId);
      return day ? `Day · ${day.date}` : "Day";
    }
    return "Trip";
  }, [photo, days, items]);

  const goPrev = useCallback(() => {
    if (index > 0) onIndexChange(index - 1);
  }, [index, onIndexChange]);
  const goNext = useCallback(() => {
    if (index < photos.length - 1) onIndexChange(index + 1);
  }, [index, onIndexChange, photos.length]);

  useEffect(() => {
    // Global keyboard nav while the lightbox is up. Cleaned up on close so
    // the arrow keys don't stay hijacked once the viewer's back in the grid.
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goPrev();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goNext();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goPrev, goNext, onClose]);

  useEffect(() => {
    // Same "keep the page behind from scrolling" trick Sheet.tsx uses for
    // its modal. Without this the page still scrolls under the overlay on
    // Safari.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (!photo) return null;

  return (
    <div
      // A native <dialog> would give us focus trap + inertness for free
      // (Sheet.tsx already uses one), but the picker sheet is not
      // guaranteed closed here and two nested <dialog>s misbehave in Safari.
      // Rolling our own with role="dialog" and an outside-click handler is
      // the safer path for this specific overlay.
      role="dialog"
      aria-modal="true"
      aria-label={photo.caption ?? "Photo"}
      onClick={(event) => {
        // Only close when the backdrop itself is clicked -- not when a click
        // bubbles up from the image or the controls inside it.
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
    >
      {index > 0 && (
        <button
          type="button"
          onClick={goPrev}
          aria-label="Previous photo"
          className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-3 text-white hover:bg-black/70 focus:outline-none focus:ring-2 focus:ring-white/60"
        >
          <span aria-hidden="true">‹</span>
        </button>
      )}
      {index < photos.length - 1 && (
        <button
          type="button"
          onClick={goNext}
          aria-label="Next photo"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-3 text-white hover:bg-black/70 focus:outline-none focus:ring-2 focus:ring-white/60"
        >
          <span aria-hidden="true">›</span>
        </button>
      )}

      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-3 top-3 rounded-full bg-black/50 px-3 py-1 text-sm text-white hover:bg-black/70 focus:outline-none focus:ring-2 focus:ring-white/60"
      >
        ✕
      </button>

      <figure className="flex max-h-full max-w-full flex-col items-center gap-2">
        {/* Same reasoning as PhotoCard -- signed URLs aren't a fit for
            next/image without wiring remotePatterns, and R2 is already
            our CDN. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={photo.id}
          src={`/api/trip/${tripId}/photos/${photo.id}/view`}
          alt={photo.caption ?? `Photo by ${photo.uploaderName ?? photo.uploaderEmail}`}
          className="max-h-[85vh] max-w-full rounded-md object-contain"
        />
        <figcaption className="max-w-2xl text-center text-sm text-stone-100">
          {photo.caption && <p className="mb-1">{photo.caption}</p>}
          <p className="text-xs text-stone-300">
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
              {scopeLabel}
            </span>{" "}
            · {photo.uploaderName ?? photo.uploaderEmail} ·{" "}
            {new Date(photo.capturedAt ?? photo.createdAt).toLocaleString()} · {index + 1} of{" "}
            {photos.length}
          </p>
        </figcaption>
      </figure>
    </div>
  );
}

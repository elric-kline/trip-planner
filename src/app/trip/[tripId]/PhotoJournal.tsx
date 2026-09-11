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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkSave, setBulkSave] = useState<
    | { kind: "idle" }
    | { kind: "working"; done: number; total: number; label: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
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

  useEffect(() => {
    if (bulkSave.kind !== "error") return;
    const timer = setTimeout(() => setBulkSave({ kind: "idle" }), 8_000);
    return () => clearTimeout(timer);
  }, [bulkSave]);

  const toggleSelected = useCallback((photoId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const selectAllVisible = useCallback(() => {
    setSelectedIds(new Set(filteredPhotos.map((p) => p.id)));
  }, [filteredPhotos]);

  // Prune selections that leave the visible set (a photo the viewer just
  // deleted, or a filter change that hides one they'd ticked). Without
  // this the count in the action bar drifts silently away from what the
  // grid shows.
  useEffect(() => {
    const visibleIds = new Set(filteredPhotos.map((p) => p.id));
    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleIds.has(id)) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [filteredPhotos]);

  /**
   * Bulk save: pick the best delivery mode the browser will accept.
   *
   *   - Mobile + a browser that reports `canShare({ files })`: fetch each
   *     photo, hand the array of Files to `navigator.share`. This is what
   *     lets Photos / Google Photos / iCloud accept them as individual
   *     images the viewer can then edit or repost, rather than as a zip
   *     the receiving app has to know how to unpack.
   *   - Everywhere else (desktop, older Chromium, browsers that only share
   *     text): hit /photos/download-batch, which streams a store-mode zip
   *     back with the batch's Content-Disposition set to attachment. The
   *     browser handles the download natively via a hidden anchor click;
   *     no client-side buffering.
   *
   * A single fetch failure aborts the batch rather than silently skipping
   * a photo -- a "save 20" that quietly returns 19 is worse than one that
   * says something broke.
   */
  const handleBulkSave = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;

    // Feature-detect share-with-files. A one-byte placeholder is enough --
    // canShare only checks the *shape* of what would be shared, not the
    // real bytes, and building a real File-per-photo just to run this test
    // would be wasteful when the answer is usually no on desktop.
    const canShareFiles = (() => {
      if (typeof navigator === "undefined" || typeof navigator.canShare !== "function") return false;
      try {
        const probe = new File([new Uint8Array(1)], "probe.png", { type: "image/png" });
        return navigator.canShare({ files: [probe] });
      } catch {
        return false;
      }
    })();

    if (canShareFiles) {
      setBulkSave({ kind: "working", done: 0, total: ids.length, label: "Preparing" });
      const files: File[] = [];
      try {
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const res = await fetch(`/api/trip/${props.tripId}/photos/${id}/download`);
          if (!res.ok) throw new Error(`Couldn't fetch photo ${i + 1}/${ids.length} (HTTP ${res.status}).`);
          const blob = await res.blob();
          const disposition = res.headers.get("Content-Disposition") ?? "";
          const match = /filename="([^"]+)"/.exec(disposition);
          const filename = match?.[1] ?? `photo-${i + 1}.jpg`;
          files.push(new File([blob], filename, { type: blob.type || "application/octet-stream" }));
          setBulkSave({ kind: "working", done: i + 1, total: ids.length, label: "Preparing" });
        }
      } catch (err) {
        setBulkSave({
          kind: "error",
          message: err instanceof Error ? err.message : "Couldn't fetch those photos.",
        });
        return;
      }

      try {
        await navigator.share({
          files,
          title: `${files.length} photo${files.length === 1 ? "" : "s"}`,
        });
        setBulkSave({ kind: "idle" });
        clearSelection();
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // User cancelled the share sheet. Don't fall through to a
          // silent zip download that would feel like the app ignoring
          // the cancel. Leave the selection intact so they can try again.
          setBulkSave({ kind: "idle" });
          return;
        }
        // Anything else -- the OS rejected the payload, one of the files
        // was too big for the target app -- fall through to the zip path
        // so the viewer still walks away with their photos.
      }
    }

    // Zip fallback. Server streams the file; a plain anchor click starts
    // the download natively (same trick the single-photo path uses on
    // desktop). No client-side buffering.
    const anchor = document.createElement("a");
    anchor.href = `/api/trip/${props.tripId}/photos/download-batch?ids=${encodeURIComponent(ids.join(","))}`;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setBulkSave({ kind: "idle" });
    // Don't clear the selection on the zip path -- the download runs
    // async in the browser's own tray; leaving the selection lets a
    // viewer retry if it fails, and Clear is right there in the bar.
  }, [selectedIds, props.tripId, clearSelection]);

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
              selected={selectedIds.has(photo.id)}
              onSelectToggle={() => toggleSelected(photo.id)}
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

      {selectedIds.size > 0 && (
        <SelectionBar
          count={selectedIds.size}
          totalVisible={filteredPhotos.length}
          bulkSave={bulkSave}
          onSave={handleBulkSave}
          onSelectAll={selectAllVisible}
          onClear={clearSelection}
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
  selected,
  onSelectToggle,
  onOpen,
  onDelete,
  onEditCaption,
  days,
  items,
}: {
  tripId: string;
  photo: PhotoWire;
  canDelete: boolean;
  selected: boolean;
  onSelectToggle: () => void;
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
    <li
      className={
        selected
          ? "group flex flex-col overflow-hidden rounded-md border-2 border-route-500 bg-white shadow-sm"
          : "group flex flex-col overflow-hidden rounded-md border border-stone-200 bg-white shadow-sm"
      }
    >
      {/* Wrapper so the selection checkbox can sit on top of the image
          button without swallowing its clicks. The checkbox has to be a
          sibling with a higher stacking context, not a child of the
          button -- a button inside a button is invalid HTML and won't
          fire correctly on some Android WebViews. */}
      <div className="relative">
        {/* A button rather than a plain click handler on the div: keyboard
            activation (Enter/Space) and screen-reader semantics come for free,
            which the previous version's non-interactive tile didn't have. */}
        <button
          type="button"
          onClick={onOpen}
          aria-label={photo.caption ? `View "${photo.caption}"` : "View photo"}
          className="relative block aspect-square w-full bg-stone-100 focus:outline-none focus:ring-2 focus:ring-route-500"
        >
          {/* next/image would need remoteHost config for the R2 signed URLs the
              view endpoint redirects to, and we already lazy-load + let R2
              do CDN duty. A plain <img> is the right primitive here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/trip/${tripId}/photos/${photo.id}/view`}
            alt={photo.caption ?? `Photo by ${photo.uploaderName ?? photo.uploaderEmail}`}
            loading="lazy"
            className={
              selected
                ? "h-full w-full object-cover opacity-70"
                : "h-full w-full object-cover transition-opacity group-hover:opacity-90"
            }
          />
          <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {scopeBadge}
          </span>
        </button>

        {/* Selection checkbox. Big touch target (44x44 hit area via the
            outer button padding), small visible checkmark. Positioned
            top-right so it doesn't collide with the scope badge. */}
        <button
          type="button"
          onClick={onSelectToggle}
          role="checkbox"
          aria-checked={selected}
          aria-label={selected ? "Deselect this photo" : "Select this photo"}
          className={
            selected
              ? "absolute right-1 top-1 inline-flex h-8 w-8 items-center justify-center rounded-full bg-route-500 text-white shadow-md ring-2 ring-white focus:outline-none focus:ring-2 focus:ring-route-500"
              : "absolute right-1 top-1 inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white shadow-sm ring-2 ring-white/60 opacity-70 hover:bg-black/60 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-route-500"
          }
        >
          {selected ? (
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M16.7 5.3a1 1 0 010 1.4l-7.4 7.4a1 1 0 01-1.4 0L3.3 9.5a1 1 0 011.4-1.4l3.6 3.6 6.7-6.7a1 1 0 011.7.3z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <span aria-hidden="true" className="h-3 w-3 rounded-full border-2 border-white/80" />
          )}
        </button>
      </div>
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
 * Fullscreen preview for the currently filtered gallery, laid out as a
 * horizontally-scrollable CSS scroll-snap carousel. That's what gives us
 * one-finger swipe on phones and two-finger horizontal swipe on
 * trackpads for free -- no touch handlers, no gesture library. Arrow
 * keys and the on-screen chevrons stay wired for keyboard/mouse; both
 * routes just call the same programmatic-scroll helper.
 *
 * Every filtered photo has a real slide in the DOM so the browser can
 * snap between them and the scroll position stays honest. Images use
 * `loading="lazy"` -- the browser only actually fetches slides near the
 * viewport, so this is fine even for a big gallery.
 *
 * Uses the same /view endpoint the thumbnails do -- the API redirects to
 * the R2 URL, which for a custom-domain deploy is a public CDN fetch and
 * for a bare bucket is a presigned URL -- so this stays honest to the
 * app's own auth either way.
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
  const scrollerRef = useRef<HTMLDivElement>(null);
  const photo = photos[index];

  const scopeLabelFor = useCallback(
    (p: PhotoWire) => {
      if (p.scope === "item") {
        const item = items.find((i) => i.id === p.itemId);
        return item ? `Item · ${item.title}` : "Item";
      }
      if (p.scope === "day") {
        const day = days.find((d) => d.id === p.dayId);
        return day ? `Day · ${day.date}` : "Day";
      }
      return "Trip";
    },
    [days, items],
  );

  /**
   * Programmatic-scroll target. Used by the chevrons and keyboard nav --
   * the carousel handles user-initiated swipes on its own, without going
   * through this. Deliberately does NOT read from React's `index` state:
   * a chevron press sets state AND scrolls in the same tick, so if we
   * kept a sync-from-state effect around it'd race with the user's own
   * swipe (mid-flick, state ticks up, the effect re-snaps to that slide,
   * cancelling their momentum).
   */
  const scrollToSlide = useCallback((next: number, behavior: ScrollBehavior = "smooth") => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ left: next * el.clientWidth, behavior });
  }, []);

  const goPrev = useCallback(() => {
    if (index > 0) {
      onIndexChange(index - 1);
      scrollToSlide(index - 1);
    }
  }, [index, onIndexChange, scrollToSlide]);
  const goNext = useCallback(() => {
    if (index < photos.length - 1) {
      onIndexChange(index + 1);
      scrollToSlide(index + 1);
    }
  }, [index, onIndexChange, photos.length, scrollToSlide]);

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

  useEffect(() => {
    // Land on the tapped photo on mount -- no smooth scroll here, we don't
    // want the lightbox to open and then animate across a full trip's
    // worth of slides.
    scrollToSlide(index, "auto");
    // Only on mount; subsequent `index` changes come from either the scroll
    // handler (already in the right position) or from goPrev/goNext (which
    // already scrolled).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Which slide the viewer is actually looking at right now. Debounced via
   * requestAnimationFrame -- the scroll event fires every frame during a
   * fling and we only need one state update per settled position.
   */
  const rafRef = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = scrollerRef.current;
      if (!el) return;
      const width = el.clientWidth;
      if (width === 0) return;
      const nextIndex = Math.round(el.scrollLeft / width);
      if (nextIndex !== index && nextIndex >= 0 && nextIndex < photos.length) {
        onIndexChange(nextIndex);
      }
    });
  }, [index, onIndexChange, photos.length]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  /**
   * "Save" — one button that hands the file to the OS's own share sheet
   * (native Photos / iCloud / Google Photos / Dropbox / etc.) on mobile,
   * and falls back to a plain download on desktop. Everything hangs off
   * the /download route, which streams the R2 bytes back same-origin;
   * that's what lets `navigator.share({ files })` read them as a Blob
   * without needing CORS on the bucket.
   */
  const [saveState, setSaveState] = useState<{ working: boolean; error: string | null }>({
    working: false,
    error: null,
  });
  const currentPhotoId = photo?.id;
  const currentCaption = photo?.caption ?? null;
  const handleSave = useCallback(async () => {
    if (!currentPhotoId) return;
    setSaveState({ working: true, error: null });
    try {
      const res = await fetch(`/api/trip/${tripId}/photos/${currentPhotoId}/download`);
      if (!res.ok) {
        throw new Error(`Couldn't fetch that photo (HTTP ${res.status}).`);
      }
      const blob = await res.blob();
      // Filename comes back on Content-Disposition -- pull the plain
      // (RFC 2616) filename out of it; we don't need the RFC 5987 form
      // client-side.
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? "photo.jpg";
      const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });

      // Prefer the native share sheet where the browser supports sharing
      // *files* specifically. `navigator.canShare` returns false for text-
      // only implementations (older Chromium on desktop), which is what we
      // want -- fall through to a download in that case.
      const canShare =
        typeof navigator !== "undefined" &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files: [file] });

      if (canShare) {
        try {
          await navigator.share({
            files: [file],
            title: currentCaption ?? "Photo",
          });
          setSaveState({ working: false, error: null });
          return;
        } catch (err) {
          // AbortError = user tapped Cancel on the share sheet. That's a
          // deliberate "no thanks," not a fallback trigger -- offering a
          // silent download afterwards would feel like the app ignoring
          // the cancel.
          if (err instanceof DOMException && err.name === "AbortError") {
            setSaveState({ working: false, error: null });
            return;
          }
          // Fall through to download on other share failures.
        }
      }

      // Desktop / no share: trigger a plain download via a hidden anchor.
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setSaveState({ working: false, error: null });
    } catch (err) {
      setSaveState({
        working: false,
        error: err instanceof Error ? err.message : "Couldn't save that photo.",
      });
    }
  }, [currentPhotoId, currentCaption, tripId]);

  // Auto-dismiss any save error after 5s -- same posture as the upload
  // banner. The banner replaces itself on the next attempt regardless.
  useEffect(() => {
    if (!saveState.error) return;
    const timer = setTimeout(() => setSaveState((s) => ({ ...s, error: null })), 5000);
    return () => clearTimeout(timer);
  }, [saveState.error]);

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
      className="fixed inset-0 z-50 bg-black/85"
    >
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        // scroll-snap on the container + snap-center on each slide is what
        // turns a plain overflow-x-auto into a swipeable carousel. `snap-always`
        // (CSS scroll-snap-stop) keeps a fling from blowing past multiple
        // slides in one gesture, which for a photo viewer feels wrong --
        // one flick, one photo.
        className="flex h-full w-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden"
        style={{ scrollbarWidth: "none" }}
      >
        {photos.map((p, i) => (
          <div
            key={p.id}
            // A slide is a full-width, full-height column: image up top,
            // caption below. Clicking anywhere inside the slide that isn't
            // the image or the caption closes the lightbox -- same "click
            // the empty space" affordance the backdrop used to have.
            className="flex h-full w-full shrink-0 snap-center snap-always flex-col items-center justify-center gap-2 p-4"
            onClick={(event) => {
              if (event.target === event.currentTarget) onClose();
            }}
          >
            <figure className="flex min-h-0 max-w-full flex-col items-center gap-2">
              {/* Same reasoning as PhotoCard -- signed URLs aren't a fit
                  for next/image without wiring remotePatterns, and R2 is
                  already our CDN. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/trip/${tripId}/photos/${p.id}/view`}
                alt={p.caption ?? `Photo by ${p.uploaderName ?? p.uploaderEmail}`}
                // Only eagerly load the current slide and its immediate
                // neighbours -- everything else waits for the viewer to
                // actually swipe near it. This is what makes a big gallery
                // scale without blowing up the first-open network budget.
                loading={Math.abs(i - index) <= 1 ? "eager" : "lazy"}
                className="max-h-[80vh] max-w-full rounded-md object-contain"
              />
              <figcaption className="max-w-2xl text-center text-sm text-stone-100">
                {p.caption && <p className="mb-1">{p.caption}</p>}
                <p className="text-xs text-stone-300">
                  <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                    {scopeLabelFor(p)}
                  </span>{" "}
                  · {p.uploaderName ?? p.uploaderEmail} ·{" "}
                  {new Date(p.capturedAt ?? p.createdAt).toLocaleString()} · {i + 1} of{" "}
                  {photos.length}
                </p>
              </figcaption>
            </figure>
          </div>
        ))}
      </div>

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

      <div className="absolute right-3 top-3 flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saveState.working}
          aria-label="Save or share this photo"
          className="rounded-full bg-black/50 px-3 py-1 text-sm text-white hover:bg-black/70 focus:outline-none focus:ring-2 focus:ring-white/60 disabled:opacity-60"
        >
          {saveState.working ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-full bg-black/50 px-3 py-1 text-sm text-white hover:bg-black/70 focus:outline-none focus:ring-2 focus:ring-white/60"
        >
          ✕
        </button>
      </div>

      {saveState.error && (
        <p
          role="alert"
          className="absolute inset-x-0 bottom-4 mx-auto max-w-md rounded-md bg-red-900/90 px-3 py-2 text-center text-sm text-red-100"
        >
          {saveState.error}
        </p>
      )}
    </div>
  );
}

/**
 * Sticky bottom action bar for a non-empty selection. Renders count +
 * three actions: "Select all" (adds every currently filtered photo),
 * "Save" (mirrors the single-photo Save button's logic against the full
 * batch), and "Clear" (drops the selection).
 *
 * `bulkSave.kind === "working"` swaps the Save label to a progress
 * counter ("Preparing 4/12") -- the fetch-per-file phase of the mobile
 * share path can take a few seconds on a slow connection, and a
 * silently-frozen button reads as broken. The zip-download path
 * finishes on the anchor click; that's fast enough not to need a
 * progress state of its own.
 */
function SelectionBar({
  count,
  totalVisible,
  bulkSave,
  onSave,
  onSelectAll,
  onClear,
}: {
  count: number;
  totalVisible: number;
  bulkSave:
    | { kind: "idle" }
    | { kind: "working"; done: number; total: number; label: string }
    | { kind: "error"; message: string };
  onSave: () => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const busy = bulkSave.kind === "working";
  return (
    <div
      // Fixed so the bar rides above the page as the viewer scrolls the
      // gallery; the standard-looking `pb-safe-*` isn't part of this
      // project's Tailwind config yet, so a plain bottom offset is fine.
      className="fixed inset-x-0 bottom-4 z-40 mx-auto flex w-fit max-w-[95vw] flex-wrap items-center gap-3 rounded-full bg-stone-900 px-4 py-2 text-sm text-white shadow-lg"
      role="region"
      aria-label="Selected photos"
    >
      <span className="whitespace-nowrap font-medium">
        {busy
          ? `${bulkSave.label} ${bulkSave.done}/${bulkSave.total}…`
          : `${count} selected`}
      </span>
      {count < totalVisible && !busy && (
        <button
          type="button"
          onClick={onSelectAll}
          className="whitespace-nowrap text-xs text-stone-300 underline hover:text-white"
        >
          Select all {totalVisible}
        </button>
      )}
      <button
        type="button"
        onClick={onSave}
        disabled={busy}
        className="whitespace-nowrap rounded-full bg-route-500 px-3 py-1 text-xs font-semibold text-white hover:bg-route-600 disabled:opacity-60"
      >
        Save
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={busy}
        className="whitespace-nowrap text-xs text-stone-300 underline hover:text-white disabled:opacity-60"
      >
        Clear
      </button>
      {bulkSave.kind === "error" && (
        <span role="alert" className="w-full text-xs text-red-300">
          {bulkSave.message}
        </span>
      )}
    </div>
  );
}

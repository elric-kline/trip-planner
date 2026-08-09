"use client";

import { useEffect, useRef } from "react";

/**
 * A modal bottom sheet wrapping the platform's own `<dialog>`.
 *
 * Using the real element rather than a positioned div is what buys the focus
 * trap, Escape-to-close, inertness of the page behind it, and rendering above
 * every stacking context -- all the parts of a modal that are tedious to get
 * right and easy to get subtly wrong. What's left here is the two things
 * `<dialog>` doesn't do: mirroring React state onto `showModal()`/`close()`,
 * and treating a click on the backdrop as a dismissal.
 *
 * Backdrop clicks are detected by comparing the event target to the dialog
 * itself, which only works because the element carries no padding of its own
 * (see `.sheet` in globals.css) and everything visible lives in the child
 * below -- so any click that lands on the dialog box is, by construction, a
 * click on the backdrop.
 */
export default function Sheet({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  // Safari still scrolls the page behind an open dialog, which on a sheet
  // reads as the content sliding away underneath you.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="sheet-title"
      // Fires for Escape and for programmatic close alike, so the parent's
      // state can never drift out of step with the element's own.
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="flex max-h-[88dvh] flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-stone-200 px-4 py-3">
          <div>
            <h2 id="sheet-title" className="text-base font-semibold text-stone-900">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-sm text-stone-500">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 flex size-11 shrink-0 items-center justify-center text-2xl leading-none text-stone-400 hover:text-stone-700"
          >
            ×
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </div>
    </dialog>
  );
}

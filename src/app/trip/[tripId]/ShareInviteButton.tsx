"use client";

import { useState } from "react";

/**
 * The invite link used to be printed as bare text in a banner, which on a
 * phone meant long-pressing and dragging selection handles across a 32-character
 * token before you could paste it anywhere -- the single most important action
 * in a group product, gated behind the fiddliest gesture the platform has.
 *
 * Three tiers, best first: the native share sheet (Messages, WhatsApp, Mail,
 * AirDrop) where `navigator.share` exists, the clipboard where it doesn't, and
 * the raw URL underneath in every case. That last one is deliberate rather than
 * a fallback -- `navigator.share` needs a secure context and a user gesture,
 * `navigator.clipboard` needs a secure context too, and either can be missing
 * or refused. Something copyable is always on screen.
 */
export default function ShareInviteButton({
  url,
  tripName,
  delivery = "none",
}: {
  url: string;
  tripName: string;
  /**
   * Whether the invite actually reached anyone. "none" means no address was
   * given, so sharing the link is the whole job; "failed" means we tried and
   * couldn't, which the planner needs to know before assuming it arrived.
   */
  delivery?: "sent" | "failed" | "none";
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function share() {
    const payload = {
      title: `Join ${tripName}`,
      text: `Come plan ${tripName} with me:`,
      url,
    };

    if (typeof navigator.share === "function") {
      try {
        await navigator.share(payload);
        return;
      } catch (err) {
        // Dismissing the sheet rejects with AbortError -- that's a decision,
        // not a failure, so don't fall through to copying behind their back.
        if (err instanceof Error && err.name === "AbortError") return;
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
      setTimeout(() => setState("idle"), 2500);
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3">
      <p className="mb-2 text-sm font-medium text-blue-900">
        {delivery === "sent"
          ? `Invite sent. They can also use this link.`
          : delivery === "failed"
            ? `We couldn't send that email — share this link instead.`
            : `Invite link ready — anyone with it can join ${tripName}.`}
      </p>
      <button type="button" onClick={share} className="btn-primary w-full sm:w-auto">
        Share invite
      </button>
      {state === "copied" && (
        <p aria-live="polite" className="mt-2 text-sm text-blue-800">
          Link copied.
        </p>
      )}
      {state === "failed" && (
        <p aria-live="polite" className="mt-2 text-sm text-blue-800">
          Couldn&apos;t copy automatically — the link is below.
        </p>
      )}
      <p className="mt-2 break-all font-mono text-xs text-blue-800/80">{url}</p>
    </div>
  );
}

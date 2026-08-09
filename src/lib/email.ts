/**
 * Delivery goes through Resend's plain REST API rather than their SDK — one
 * `fetch` call, no dependency to track, consistent with using Node's built-in
 * scrypt over adding bcrypt for password hashing.
 *
 * Both RESEND_API_KEY and EMAIL_FROM must be set to actually send; with
 * either missing, the link is logged to the console instead — which is what
 * makes local sign-in work with no provider account at all.
 */
const RESEND_API_URL = "https://api.resend.com/emails";

function magicLinkEmailHtml(url: string): string {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h1 style="font-size: 18px; margin-bottom: 8px;">
        <span style="color: #0f766e;">Agree</span>Mobile
      </h1>
      <p style="color: #44403c; font-size: 14px;">
        Click below to sign in. This link works once and expires in 15 minutes.
      </p>
      <p style="margin: 24px 0;">
        <a href="${url}" style="background: #0f766e; color: white; padding: 10px 16px;
          border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 600;">
          Sign in to AgreeMobile
        </a>
      </p>
      <p style="color: #78716c; font-size: 12px;">
        Didn't request this? You can safely ignore this email.
      </p>
    </div>
  `;
}

/**
 * One place that actually talks to Resend, so every kind of mail shares the
 * same unconfigured-falls-back-to-console behaviour. `consoleLine` is what
 * gets printed in that case -- the whole point of the fallback is that a
 * developer with no provider account can still follow the link.
 */
async function deliver(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  consoleLine: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    if (apiKey || from) {
      console.warn(
        "[email] Both RESEND_API_KEY and EMAIL_FROM must be set to send real email — falling back to console.",
      );
    }
    console.log(`\n  ${opts.consoleLine}\n`);
    return;
  }

  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend API error (${response.status}): ${body}`);
  }
}

export async function sendMagicLink(to: string, url: string): Promise<void> {
  await deliver({
    to,
    subject: "Sign in to AgreeMobile",
    html: magicLinkEmailHtml(url),
    text: `Sign in to AgreeMobile: ${url}\n\nThis link works once and expires in 15 minutes.`,
    consoleLine: `Sign-in link for ${to}:\n  ${url}`,
  });
}

/**
 * The trip invite itself, rather than a link the planner has to deliver by
 * hand. "Invite by email" used to send nothing at all -- it only scoped the
 * link to that address, invisibly, so the field promised delivery and quietly
 * did the opposite.
 */
export async function sendTripInvite(
  to: string,
  url: string,
  opts: { tripName: string; invitedBy: string; asCoPlanner: boolean },
): Promise<void> {
  const roleLine = opts.asCoPlanner
    ? "You'll join as a co-planner, so you can lock things into the itinerary too."
    : "You'll be able to suggest ideas and say what you're up for.";

  await deliver({
    to,
    subject: `${opts.invitedBy} invited you to ${opts.tripName}`,
    html: tripInviteEmailHtml(url, { ...opts, roleLine }),
    text:
      `${opts.invitedBy} invited you to help plan ${opts.tripName}.\n\n` +
      `${roleLine}\n\nJoin here: ${url}\n\n` +
      `This invite is for ${to} and expires in 14 days.`,
    consoleLine: `Invite to ${opts.tripName} for ${to}:\n  ${url}`,
  });
}

function tripInviteEmailHtml(
  url: string,
  opts: { tripName: string; invitedBy: string; roleLine: string },
): string {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h1 style="font-size: 18px; margin-bottom: 8px;">
        <span style="color: #0f766e;">Agree</span>Mobile
      </h1>
      <p style="color: #44403c; font-size: 14px;">
        <strong>${escapeHtml(opts.invitedBy)}</strong> invited you to help plan
        <strong>${escapeHtml(opts.tripName)}</strong>.
      </p>
      <p style="color: #44403c; font-size: 14px;">${escapeHtml(opts.roleLine)}</p>
      <p style="margin: 24px 0;">
        <a href="${url}" style="background: #0f766e; color: white; padding: 10px 16px;
          border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 600;">
          Join the trip
        </a>
      </p>
      <p style="color: #78716c; font-size: 12px;">
        Not expecting this? You can safely ignore it — nothing happens until you accept.
      </p>
    </div>
  `;
}

/**
 * A trip name and an inviter's name are user-supplied, and they land in an
 * HTML document. The magic-link mail never had this problem because it
 * interpolates nothing but a URL we generated ourselves.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** True when links actually get emailed rather than logged to the console. */
export const emailDeliveryConfigured = () =>
  Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);

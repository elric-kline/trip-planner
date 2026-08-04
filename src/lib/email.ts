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

export async function sendMagicLink(to: string, url: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    if (apiKey || from) {
      console.warn(
        "[email] Both RESEND_API_KEY and EMAIL_FROM must be set to send real email — falling back to console.",
      );
    }
    console.log(`\n  Sign-in link for ${to}:\n  ${url}\n`);
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
      to,
      subject: "Sign in to AgreeMobile",
      html: magicLinkEmailHtml(url),
      text: `Sign in to AgreeMobile: ${url}\n\nThis link works once and expires in 15 minutes.`,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend API error (${response.status}): ${body}`);
  }
}

/** True when sign-in links actually get emailed rather than logged to the console. */
export const emailDeliveryConfigured = () =>
  Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);

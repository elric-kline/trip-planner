/**
 * Delivery is deliberately a single function so swapping in Resend/SES later
 * touches nothing else. With EMAIL_FROM unset we log the link instead, which
 * is what makes local sign-in work without an email provider.
 */
export async function sendMagicLink(to: string, url: string): Promise<void> {
  if (!process.env.EMAIL_FROM) {
    console.log(`\n  Sign-in link for ${to}:\n  ${url}\n`);
    return;
  }
  throw new Error(
    "EMAIL_FROM is set but no email provider is wired up yet. Implement sendMagicLink.",
  );
}

/** True when sign-in links surface in the UI rather than arriving by email. */
export const emailDeliveryConfigured = () => Boolean(process.env.EMAIL_FROM);

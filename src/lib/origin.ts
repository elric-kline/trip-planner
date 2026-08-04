export type OriginInput = {
  appUrl?: string;
  isProduction: boolean;
  forwardedProto?: string;
  forwardedHost?: string;
  host?: string;
};

/**
 * The actual decision logic for absoluteOrigin(), kept in its own module
 * with no `next/headers` import so it's importable — and unit-testable —
 * outside a Next.js request context.
 *
 * `appUrl` wins outright — an email link especially should always point at
 * the domain people are meant to trust, not whatever host happened to
 * receive this particular request. In production, the scheme is forced to
 * `https` regardless of headers: this app never legitimately serves plain
 * HTTP, and a link that could resolve to `http://` for a page that collects
 * a password is exactly the kind of mismatch phishing filters look for.
 */
export function resolveOrigin(input: OriginInput): string {
  if (input.appUrl) return input.appUrl.replace(/\/$/, "");

  const host = input.forwardedHost ?? input.host ?? "localhost:3000";
  const proto = input.isProduction ? "https" : (input.forwardedProto ?? "http");

  return `${proto}://${host}`;
}

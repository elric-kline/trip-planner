/**
 * The AgreeMobile mark: a map pin (the trip) with a checkmark inside (the agreement).
 * Single-color fill so it drops cleanly onto any background — see docs/BRAND.md.
 */
export function LogoMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M12 2C7.58 2 4 5.58 4 10c0 5.25 6.72 11.19 7.31 11.71a1 1 0 0 0 1.38 0C13.28 21.19 20 15.25 20 10c0-4.42-3.58-8-8-8Z"
        fill="currentColor"
      />
      <path
        d="M8.5 10.4 10.8 12.7 15.1 8.1"
        stroke="white"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-display font-bold tracking-tight ${className}`}>
      <LogoMark className="h-6 w-6 shrink-0 text-route-600" />
      <span>
        <span className="text-pine-800">Agree</span>
        <span className="text-route-600">Mobile</span>
      </span>
    </span>
  );
}

const stroke = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function SearchIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.4" aria-hidden="true" {...stroke}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20 L16 16" />
    </svg>
  );
}

export function UserIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.2" aria-hidden="true" {...stroke}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1-4 4-6 8-6s7 2 8 6" />
    </svg>
  );
}

export function CartIcon({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.4" aria-hidden="true" {...stroke}>
      <path d="M3 4h2l2.4 11h11l2-8H6.2" />
      <circle cx="9" cy="20" r="1.4" />
      <circle cx="18" cy="20" r="1.4" />
    </svg>
  );
}

export function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="2.4"
      fill={filled ? "currentColor" : "none"}
      aria-hidden="true"
    >
      <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
    </svg>
  );
}

/** Pelita mark for the rose header: white square, rose plus, yellow flame (docs/demo-pelita/logo.svg inverted). */
export function PelitaMarkOnRose() {
  return (
    <svg viewBox="0 0 72 80" width="46" height="51" aria-hidden="true">
      <rect x="0" y="4" width="72" height="72" rx="20" fill="#fff" />
      <path
        d="M28 16 h16 a4 4 0 0 1 4 4 v12 h12 a4 4 0 0 1 4 4 v16 a4 4 0 0 1 -4 4 h-12 v12 a4 4 0 0 1 -4 4 h-16 a4 4 0 0 1 -4 -4 v-12 h-12 a4 4 0 0 1 -4 -4 v-16 a4 4 0 0 1 4 -4 h12 v-12 a4 4 0 0 1 4 -4z"
        fill="#B5195B"
      />
      <path d="M36 27 C44 36 46 43 42 49 C40 52 38 53 36 53 C34 53 32 52 30 49 C26 43 28 36 36 27Z" fill="#FFC93C" />
      <path d="M36 38 C39 42 39 46 37 48.5 C36.4 49.2 35.6 49.2 35 48.5 C33 46 33 42 36 38Z" fill="#fff" />
    </svg>
  );
}

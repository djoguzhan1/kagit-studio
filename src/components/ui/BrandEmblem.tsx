/**
 * Iconic KÂĞIT Studio Brand Emblem:
 * Curled warm ivory flipbook sheet + left ACME pegbar perforations +
 * upward-soaring vermilion motion ribbon & crisp origami paper-plane tip.
 * Zero unintentional facial/frown symmetry at any scale (16px favicon to 48px header).
 */
export function BrandEmblem({ className = 'w-9 h-9' }: { className?: string }) {
  return (
    <div
      className={`brand-emblem relative rounded-xl bg-[#F7F3E9] border border-desk-border shadow-md flex items-center justify-center overflow-hidden shrink-0 ${className}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 40 40" className="w-full h-full">
        {/* Soft paper sheet subtle warm shading */}
        <defs>
          <linearGradient id="kagitSheetGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FFFDF8" />
            <stop offset="100%" stopColor="#ECE3D0" />
          </linearGradient>
        </defs>
        <rect width="40" height="40" fill="url(#kagitSheetGrad)" />

        {/* Left binding margin & vertical animation pegbar holes */}
        <line x1="9.5" y1="0" x2="9.5" y2="40" stroke="#D5CBB8" strokeWidth="1" strokeDasharray="2 2" />
        <circle cx="5" cy="11" r="1.7" fill="#231F1C" />
        <rect x="3.5" y="17.5" width="3" height="5.5" rx="1.5" fill="#231F1C" />
        <circle cx="5" cy="29.5" r="1.7" fill="#231F1C" />

        {/* Curled top-right flipbook page corner */}
        <path
          className="brand-emblem-curl"
          d="M29 0 L40 11 L31.5 11 C30 11 29 10 29 8.5 Z"
          fill="#D9CEBA"
          stroke="#BCAE96"
          strokeWidth="0.7"
        />

        {/* Upward-soaring vermilion motion trail & crisp origami plane dart */}
        <path
          className="brand-emblem-trail"
          d="M12.5 29 C16 27.5, 20 23.5, 24.5 18.5"
          stroke="#E54D2E"
          strokeWidth="2.8"
          strokeLinecap="round"
          fill="none"
        />
        {/* Origami plane arrowhead pointing dynamically upward-right */}
        <path
          d="M32.5 12.5 L20.5 16.2 L25 19.3 L27.8 24 Z"
          fill="#E54D2E"
          stroke="#1C1917"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path d="M32.5 12.5 L25 19.3" stroke="#FFFDF8" strokeWidth="1" strokeLinecap="round" />
      </svg>
    </div>
  );
}

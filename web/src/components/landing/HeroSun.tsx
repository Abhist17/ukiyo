import { LOGO } from "@/lib/logo";

/**
 * The hero's art is the mark itself at scale: the same sun, wave and crest as `<Logo>`, with two faint swells in the sea
 * so the large version has texture the 16 px favicon does not need.
 */
export function HeroSun() {
  return (
    <svg className="hero-sun" viewBox="0 0 64 64" aria-hidden>
      <defs>
        <radialGradient id="hs-sun" cx="40%" cy="22%" r="80%">
          <stop offset="0" stopColor="#FF9064" />
          <stop offset="0.5" stopColor={LOGO.sun} />
          <stop offset="1" stopColor="#B8321F" />
        </radialGradient>
        <linearGradient id="hs-sea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.45" stopColor={LOGO.sea} />
          <stop offset="1" stopColor="#0B0F1C" />
        </linearGradient>
        <clipPath id="hs-coin">
          <circle cx="32" cy="32" r="30" />
        </clipPath>
      </defs>
      <g clipPath="url(#hs-coin)">
        <rect width="64" height="64" fill="url(#hs-sun)" />
        <path d={`${LOGO.wave} V66 H-2Z`} fill="url(#hs-sea)" />
        <path d="M-2 44 C10 37 22 37 32 42 C42 47 54 47 66 40" fill="none" stroke={LOGO.cream} strokeOpacity="0.14" strokeWidth="0.6" />
        <path d="M-2 53 C10 47 22 47 32 51 C42 55 54 55 66 49" fill="none" stroke={LOGO.cream} strokeOpacity="0.08" strokeWidth="0.6" />
        <path d={LOGO.wave} fill="none" stroke={LOGO.cream} strokeWidth="1.1" strokeLinecap="round" />
      </g>
      <circle cx="32" cy="32" r="30.3" fill="none" stroke={LOGO.cream} strokeOpacity="0.25" strokeWidth="0.35" />
    </svg>
  );
}

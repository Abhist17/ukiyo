import { LOGO } from "@/lib/logo";

/**
 * The hero's art is the mark itself at scale, drawn like a woodblock print: the same sun and the same hook-curled wave
 * as `<Logo>`, but in fine lines, with two echoes of the wave behind it the way ukiyo-e prints draw water.
 */
export function HeroSun() {
  const { cx, cy, r } = LOGO.sunAt;
  return (
    <svg className="hero-sun" viewBox="4 8 58 50" aria-hidden>
      <defs>
        <linearGradient id="hs-sun" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F25A3B" />
          <stop offset="1" stopColor="#D93D25" />
        </linearGradient>
      </defs>
      <circle cx={cx} cy={cy} r={r} fill="url(#hs-sun)" />
      {[
        [6, 0.12],
        [3, 0.3],
      ].map(([d, o]) => (
        <path key={d} d={LOGO.wave} transform={`translate(${d} ${d})`} fill="none" stroke={LOGO.cream} strokeOpacity={o} strokeWidth="0.7" strokeLinecap="round" />
      ))}
      <path d={LOGO.swell} transform="translate(0 2)" fill="none" stroke={LOGO.cream} strokeOpacity="0.3" strokeWidth="0.7" strokeLinecap="round" />
      <path d={LOGO.wave} fill="none" stroke={LOGO.cream} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

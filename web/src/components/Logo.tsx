import { LOGO } from "@/lib/logo";

/**
 * The Ukiyo mark: a navy tile, the vermilion sun, and a wave whose crest curls into a hook. Fixed colours from
 * `lib/logo.ts`, so it is the same mark on every page, in both themes, and in the static files.
 */
export function Logo({ size = 32, title = "Ukiyo" }: { size?: number; title?: string }) {
  const { cx, cy, r } = LOGO.sunAt;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <rect x="3" y="3" width="58" height="58" rx="15" fill={LOGO.tile} />
      <rect x="3.75" y="3.75" width="56.5" height="56.5" rx="14.25" fill="none" stroke={LOGO.cream} strokeOpacity="0.18" strokeWidth="1.5" />
      <circle cx={cx} cy={cy} r={r} fill={LOGO.sun} />
      <path d={LOGO.swell} fill="none" stroke={LOGO.cream} strokeOpacity="0.45" strokeWidth="3.2" strokeLinecap="round" />
      <path d={LOGO.wave} fill="none" stroke={LOGO.cream} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Mark plus the lowercase wordmark, whose i is dotted with a small sun. */
export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: size * 0.82 }}>
      <Logo size={size} />
      <span className="wm-text" aria-label="ukiyo">
        uk<span className="wm-i" aria-hidden>ı</span>yo
      </span>
    </span>
  );
}

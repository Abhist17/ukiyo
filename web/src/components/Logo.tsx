import { useId } from "react";
import { LOGO } from "@/lib/logo";

/**
 * The Ukiyo mark: one wave (a price path) splits a coin into the vermilion sun of the floating world and the sea.
 * Fixed colours from `lib/logo.ts`, so it is the same mark on every page, in both themes, and in the static files.
 */
export function Logo({ size = 32, title = "Ukiyo" }: { size?: number; title?: string }) {
  const clip = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <defs>
        <clipPath id={clip}>
          <circle cx="32" cy="32" r="30" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect width="64" height="64" fill={LOGO.sun} />
        <path d={`${LOGO.wave} V66 H-2Z`} fill={LOGO.sea} />
        <path d={LOGO.wave} fill="none" stroke={LOGO.cream} strokeWidth="3" strokeLinecap="round" />
      </g>
      <circle cx="32" cy="32" r="30.5" fill="none" stroke={LOGO.cream} strokeOpacity="0.55" strokeWidth="1.5" />
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

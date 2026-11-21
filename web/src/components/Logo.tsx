import { useId } from "react";

/**
 * The Ukiyo mark: one wave (a price path) splits a coin into the vermilion sun of the floating world and the sea.
 * The sea follows the theme (`--logo-sea`): navy on light backgrounds, cream on dark ones, so the mark never vanishes.
 */
export function Logo({ size = 32, title = "Ukiyo", sea }: { size?: number; title?: string; sea?: string }) {
  const clip = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <defs>
        <clipPath id={clip}>
          <circle cx="32" cy="32" r="30" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect width="64" height="64" fill="#E8452C" />
        <path d="M-2 34 C10 24 22 24 32 32 C42 40 54 40 66 30 V66 H-2Z" fill={sea ?? "var(--logo-sea, #11162B)"} />
      </g>
    </svg>
  );
}

/** Mark plus the lowercase wordmark, whose i is dotted with a small sun. */
export function Wordmark({ size = 28, sea }: { size?: number; sea?: string }) {
  return (
    <span className="wordmark" style={{ fontSize: size * 0.82 }}>
      <Logo size={size} sea={sea} />
      <span className="wm-text" aria-label="ukiyo">
        uk<span className="wm-i" aria-hidden>ı</span>yo
      </span>
    </span>
  );
}

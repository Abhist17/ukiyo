/**
 * The Ukiyo mark, defined once: a navy tile, the vermilion sun of the floating world, and a cream ukiyo-e wave whose
 * crest curls into a hook (this is a Uniswap v4 hook). A faint second swell is the sea. Colours are fixed, never
 * themed, and a hairline cream rim keeps the tile's edge visible on dark backgrounds, so the mark is identical in the
 * nav, the favicon, the README and the social card. `web/test/logo.test.mts` checks the static SVG files against it.
 */
export const LOGO = {
  tile: "#11162B",
  sun: "#E8452C",
  cream: "#F4EFE6",
  /** The sun, on a 64×64 canvas. */
  sunAt: { cx: 41, cy: 22.5, r: 10.5 },
  /** The wave: rises from the bottom left and curls over into a hook. Stroked, not filled. */
  wave: "M11 50 C19 50 23 44 26 37 C29.5 29 37 26.5 42 31 C46 35 43.5 41 38.5 40.5 C35.5 40.2 35 37 37 35.8",
  /** The sea behind it. */
  swell: "M30 51 C36 51 42 49 53 44",
} as const;

/** The mark as a standalone SVG document, the source of `assets/logo.svg` and `web/src/app/icon.svg`. */
export function logoSvg(): string {
  const { cx, cy, r } = LOGO.sunAt;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Ukiyo">
  <title>Ukiyo</title>
  <!-- Generated from web/src/lib/logo.ts (npm run logo). Edit there, not here. -->
  <rect x="3" y="3" width="58" height="58" rx="15" fill="${LOGO.tile}"/>
  <rect x="3.75" y="3.75" width="56.5" height="56.5" rx="14.25" fill="none" stroke="${LOGO.cream}" stroke-opacity="0.18" stroke-width="1.5"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="${LOGO.sun}"/>
  <path d="${LOGO.swell}" fill="none" stroke="${LOGO.cream}" stroke-opacity="0.45" stroke-width="3.2" stroke-linecap="round"/>
  <path d="${LOGO.wave}" fill="none" stroke="${LOGO.cream}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

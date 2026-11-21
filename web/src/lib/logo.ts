/**
 * The Ukiyo mark, defined once. One wave (a price path) cuts a coin into the vermilion sun of the floating world and a
 * navy sea, with a cream crest on the cut and a hairline cream rim. The colours are fixed, never themed: the rim and
 * crest are what keep it legible on dark backgrounds, so the mark is identical in the nav, the favicon, the README and
 * the social card. `web/test/logo.test.mts` checks the static SVG files against these values.
 */
export const LOGO = {
  sun: "#E8452C",
  sea: "#11162B",
  cream: "#F4EFE6",
  /** The wave on a 64×64 canvas; the sea is this path closed along the bottom edge. */
  wave: "M-2 34 C10 24 22 24 32 32 C42 40 54 40 66 30",
} as const;

/** The mark as a standalone SVG document, the source of `assets/logo.svg` and `web/src/app/icon.svg`. */
export function logoSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Ukiyo">
  <title>Ukiyo</title>
  <!-- Generated from web/src/lib/logo.ts (npm run logo). Edit there, not here. -->
  <defs><clipPath id="ukiyo-coin"><circle cx="32" cy="32" r="30"/></clipPath></defs>
  <g clip-path="url(#ukiyo-coin)">
    <rect width="64" height="64" fill="${LOGO.sun}"/>
    <path d="${LOGO.wave} V66 H-2Z" fill="${LOGO.sea}"/>
    <path d="${LOGO.wave}" fill="none" stroke="${LOGO.cream}" stroke-width="3" stroke-linecap="round"/>
  </g>
  <circle cx="32" cy="32" r="30.5" fill="none" stroke="${LOGO.cream}" stroke-opacity="0.55" stroke-width="1.5"/>
</svg>
`;
}

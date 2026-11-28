/**
 * A single brushed wave across the page, the print's only ornament: swells that build, crest and curl over into a
 * hook (the curl of the Ukiyo mark), then settle. Drawn in ink, so it follows the theme; purely decorative.
 */
export function InkWave() {
  return (
    <div className="ink-wave" aria-hidden>
      <svg viewBox="0 0 1200 90" preserveAspectRatio="none">
        <path
          className="iw-swell"
          d="M0 70 C80 70 120 58 200 58 S320 70 400 66 S540 52 620 56 S760 70 860 66 S1040 54 1200 60"
        />
        <path
          className="iw-wave"
          d="M0 78 C120 78 210 72 300 64 C390 56 450 46 520 40 C590 34 640 22 700 22 C752 22 776 46 752 58 C734 67 716 54 726 46
             M752 58 C800 66 860 72 940 74 C1040 77 1120 78 1200 78"
        />
        <circle className="iw-sun" cx="1080" cy="26" r="14" />
      </svg>
    </div>
  );
}

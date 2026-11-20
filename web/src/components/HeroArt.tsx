import { WEEKS } from "@/lib/data";
import { smoothPath } from "@/lib/path";

/**
 * The hero print: a vermilion sun over a sea whose crest is the real 2024 BTC/USD weekly price path the backtest
 * replays. Seigaiha waves fill the water.
 */
export function HeroArt() {
  const W = 400;
  const prices = [WEEKS[0].btcOpen, ...WEEKS.map((w) => w.btcClose)];
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const pts = prices.map((p, i) => [(i / (prices.length - 1)) * W, 330 - ((p - lo) / (hi - lo)) * 170] as [number, number]);
  const crest = smoothPath(pts);
  const sea = `${crest} L${W} ${W} L0 ${W} Z`;
  const first = prices[0];
  const last = prices[prices.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${W}`} role="img" aria-label="A sun over a sea whose crest is the BTC/USD price in 2024">
      <defs>
        <clipPath id="frame">
          <rect x="0" y="0" width={W} height={W} rx="28" />
        </clipPath>
        <pattern id="seigaiha" width="28" height="14" patternUnits="userSpaceOnUse">
          {[12, 8, 4].map((r) => (
            <circle key={r} cx="14" cy="14" r={r} fill="none" stroke="#F4EBDC" strokeOpacity="0.22" strokeWidth="1.2" />
          ))}
          {[12, 8, 4].map((r) => (
            <g key={`e${r}`}>
              <circle cx="0" cy="7" r={r} fill="none" stroke="#F4EBDC" strokeOpacity="0.22" strokeWidth="1.2" />
              <circle cx="28" cy="7" r={r} fill="none" stroke="#F4EBDC" strokeOpacity="0.22" strokeWidth="1.2" />
            </g>
          ))}
        </pattern>
      </defs>
      <g clipPath="url(#frame)">
        <rect width={W} height={W} fill="var(--card-2)" />
        {[0, 1, 2, 3].map((i) => (
          <line key={i} x1="0" x2={W} y1={60 + i * 26} y2={60 + i * 26} stroke="var(--line)" strokeWidth="1" />
        ))}
        <circle cx="292" cy="112" r="64" fill="var(--seal)" />
        <path d={sea} fill="var(--sea)" />
        <path d={sea} fill="url(#seigaiha)" />
        <path d={crest} fill="none" stroke="var(--paper)" strokeWidth="9" strokeLinecap="round" />
        <path d={crest} fill="none" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" />
      </g>
      <rect x="0.5" y="0.5" width={W - 1} height={W - 1} rx="28" fill="none" stroke="var(--line)" />
      <text x="20" y="34" fontFamily="var(--mono)" fontSize="12" fill="var(--muted)">
        BTC/USD · 2024 · the replayed year
      </text>
      <text x="20" y={W - 18} fontFamily="var(--mono)" fontSize="12" fill="#F4EBDC" opacity="0.85">
        ${Math.round(first).toLocaleString("en-US")} → ${Math.round(last).toLocaleString("en-US")}
      </text>
    </svg>
  );
}

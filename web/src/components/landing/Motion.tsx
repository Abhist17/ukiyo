"use client";

import { useEffect } from "react";

const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/** Counts a number up from zero, keeping its decimals and thousands separators. */
function countUp(el: HTMLElement) {
  const text = el.textContent ?? "";
  const m = text.match(/[\d,]*\.?\d+/);
  if (!m) return;
  const target = Number(m[0].replace(/,/g, ""));
  const decimals = (m[0].split(".")[1] ?? "").length;
  const t0 = performance.now();
  const step = (now: number) => {
    const t = clamp((now - t0) / 1400);
    const v = (target * ease(t)).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    el.textContent = text.replace(m[0], v);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * The landing page's motion, driven entirely by data attributes so the page itself stays a server component:
 * - `data-reveal`: fades, unblurs and slides up the first time it enters the viewport (`"stagger"` does it to each
 *   child in turn);
 * - `data-scroll`: gets `--p`, its scroll progress from 0 to 1 (`"view"` while it crosses the viewport, `"pin"`
 *   while a tall section scrolls past its sticky child, `"top"` over the first screen of the page), which CSS turns
 *   into transforms;
 * - `data-count`: counts up from zero when revealed;
 * - the root gets `nav-float` while the page is scrolled, which turns the header into a floating pill.
 * With reduced motion everything is shown at once and nothing moves.
 */
export function Motion() {
  // The header detaches into a floating pill once the page leaves the top. Kept apart from the effect below so it
  // still works with reduced motion (where it simply snaps instead of easing).
  useEffect(() => {
    const root = document.documentElement;
    const onScroll = () => root.classList.toggle("nav-float", window.scrollY > 48);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      root.classList.remove("nav-float");
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    (window as unknown as { __motion?: boolean }).__motion = true;
    const reveals = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
    const scrolls = [...document.querySelectorAll<HTMLElement>("[data-scroll]")];
    for (const el of document.querySelectorAll<HTMLElement>('[data-reveal="stagger"]')) {
      [...el.children].forEach((c, i) => (c as HTMLElement).style.setProperty("--d", String(i)));
    }

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      root.classList.remove("motion");
      for (const el of scrolls) el.style.setProperty("--p", "1");
      return;
    }
    root.classList.add("motion");

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          el.classList.add("in");
          el.querySelectorAll<HTMLElement>("[data-count]").forEach(countUp);
          if (el.hasAttribute("data-count")) countUp(el);
          io.unobserve(el);
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    reveals.forEach((el) => io.observe(el));

    let raf = 0;
    const tick = () => {
      raf = 0;
      const vh = window.innerHeight;
      for (const el of scrolls) {
        const r = el.getBoundingClientRect();
        const mode = el.dataset.scroll;
        const p =
          mode === "pin" ? -r.top / Math.max(1, r.height - vh) : mode === "top" ? window.scrollY / vh : (vh - r.top) / (vh + r.height);
        el.style.setProperty("--p", clamp(p).toFixed(4));
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    tick();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);
  return null;
}

/**
 * Two huge lines of type that slide sideways in opposite directions as the page scrolls past (the section's `--p`).
 * Each line repeats its phrase so it never runs out of text while it moves.
 */
export function Marquee({ quiet, loud }: { quiet: string; loud: string }) {
  const row = (t: string) => Array.from({ length: 4 }, () => `${t} · `).join("");
  return (
    <div className="mq" aria-label={`${quiet}. ${loud}.`} role="img">
      <div className="mq-row mq-quiet" aria-hidden>{row(quiet)}</div>
      <div className="mq-row mq-loud" aria-hidden>{row(loud)}</div>
    </div>
  );
}

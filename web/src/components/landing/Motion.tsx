"use client";

import { useEffect } from "react";

const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * The landing page's motion, driven entirely by data attributes so the page itself stays a server component:
 * - `data-reveal`: fades in the first time it enters the viewport (`"stagger"` does it to each
 *   child in turn);
 * - `data-scroll`: gets `--p`, its scroll progress from 0 to 1 (`"view"` while it crosses the viewport, `"pin"`
 *   while a tall section scrolls past its sticky child, `"top"` over the first screen of the page), which CSS turns
 *   into transforms;
 * With reduced motion everything is shown at once and nothing moves.
 */
export function Motion() {
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

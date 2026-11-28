"use client";

import { useEffect, useRef } from "react";

/** One swap on its way through the pool. */
interface Swap {
  x: number;
  y: number;
  /** Position one frame ago, so the tail points back along the path actually travelled. */
  px: number;
  py: number;
  y0: number;
  /** Lane the swap ends in once the hook has read its tip. */
  lane: number;
  /** Radius, standing for the swap's size. */
  r: number;
  arb: boolean;
  /** Set once the swap has passed the hook. */
  sorted: boolean;
}

/** Block time of the animation, in ms. Real Unichain blocks are 1 s; a little slower reads better. */
const BLOCK_MS = 1100;
/** Time a swap takes to cross the whole canvas, in ms. */
const CROSS_MS = 3400;
/** Where the hook stands, as a fraction of the width. */
const GATE = 0.4;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * Swaps flow into the pool block after block. At the hook each one is sorted by its priority fee: the tipped swap that
 * lands first in a block is arbitrage and is charged to the curator as a loss; the untipped swaps after it are
 * ordinary users, whose fees and price impact are credited. Fee income counts every swap's fee; Edge does not.
 * Illustrative flow with numbers in the proportions of the BTC 2024 backtest, not live data.
 */
export function SwapSorter() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const blockRef = useRef<HTMLSpanElement>(null);
  const feeRef = useRef<HTMLElement>(null);
  const lossRef = useRef<HTMLElement>(null);
  const edgeRef = useRef<HTMLElement>(null);
  const gateRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };
    resize();

    // colours come from the theme tokens, re-read now and then so the theme toggle carries over
    let col = { ink: "#0a0d14", muted: "#636b7d", line: "#e4e7ec", seal: "#e8452c", good: "#0f7a4b" };
    const readColours = () => {
      const cs = getComputedStyle(canvas);
      const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
      col = { ink: v("--ink", col.ink), muted: v("--muted", col.muted), line: v("--line", col.line), seal: v("--seal", col.seal), good: v("--good", col.good) };
    };
    readColours();

    const swaps: Swap[] = [];
    let block = 0;
    let nextBlock = 0;
    let fees = 0;
    let loss = 0;
    let credit = 0;
    let gateFlash = 0;
    let gateArb = false;

    const laneY = (arb: boolean) => (arb ? 0.2 : 0.8) * h + rand(-0.03, 0.03) * h;

    /** Queues one block of flow: arbitrage, when there is any, is first in line because it paid to be. */
    const spawnBlock = (t: number) => {
      block++;
      const queue: Swap[] = [];
      const swap = (arb: boolean): Swap => ({ x: 0, y: 0, px: 0, py: 0, y0: 0, lane: 0, r: arb ? rand(5, 7.5) : rand(2.4, 5), arb, sorted: false });
      if (Math.random() < 0.72) queue.push(swap(true));
      const users = Math.floor(rand(1, 5));
      for (let i = 0; i < users; i++) queue.push(swap(false));
      queue.forEach((s, i) => {
        s.y0 = s.y = s.py = h * rand(0.34, 0.66);
        s.lane = laneY(s.arb);
        // later swaps of the block start further back, so they reach the hook later
        s.x = s.px = -i * (w / CROSS_MS) * 140 - 10;
        swaps.push(s);
      });
      nextBlock = t + BLOCK_MS;
    };

    /** Books a swap that has reached the end of its lane. */
    const settle = (s: Swap) => {
      const fee = s.r * 4.2;
      fees += fee;
      if (s.arb) loss += s.r * s.r * 1.05;
      else credit += fee + s.r * 1.1;
    };

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const gx = w * GATE;

      // lanes after the hook
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      for (const [y, c] of [
        [0.2, col.seal],
        [0.8, col.good],
      ] as const) {
        ctx.strokeStyle = c;
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.moveTo(gx + 24, y * h);
        ctx.lineTo(w, y * h);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // the hook: a bar that lights up in the colour of the swap it just sorted
      ctx.globalAlpha = 1;
      ctx.strokeStyle = gateFlash > 0 ? (gateArb ? col.seal : col.good) : col.muted;
      ctx.lineWidth = 2 + gateFlash * 2;
      ctx.beginPath();
      ctx.moveTo(gx, h * 0.12);
      ctx.lineTo(gx, h * 0.88);
      ctx.stroke();

      for (const s of swaps) {
        const c = s.sorted ? (s.arb ? col.seal : col.good) : col.ink;
        // a short tail pointing back along the direction of travel
        const dx = s.x - s.px;
        const dy = s.y - s.py;
        const n = Math.hypot(dx, dy) || 1;
        ctx.strokeStyle = c;
        ctx.globalAlpha = 0.22;
        ctx.lineWidth = s.r * 1.2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(s.x - (dx / n) * 26, s.y - (dy / n) * 26);
        ctx.lineTo(s.x, s.y);
        ctx.stroke();
        ctx.globalAlpha = s.sorted ? 1 : 0.6;
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
        // the priority fee, drawn as a ring: what the hook reads at the door
        if (s.arb) {
          ctx.globalAlpha = s.sorted ? 0.5 : 0.35;
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = s.sorted ? col.seal : col.ink;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    };

    // resizing clears the canvas, so draw again straight away (this is all a still frame gets, with reduced motion)
    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(canvas);

    const paintNumbers = () => {
      if (blockRef.current) blockRef.current.textContent = `block ${block.toLocaleString("en-US")}`;
      if (feeRef.current) feeRef.current.textContent = usd(fees);
      if (lossRef.current) lossRef.current.textContent = `−${usd(loss)}`;
      if (edgeRef.current) {
        const e = credit - loss;
        edgeRef.current.textContent = `${e < 0 ? "−" : "+"}${usd(Math.abs(e))}`;
        edgeRef.current.dataset.sign = e < 0 ? "neg" : "pos";
      }
      gateRef.current?.toggleAttribute("data-flash", gateFlash > 0.4);
      if (gateRef.current) gateRef.current.dataset.kind = gateArb ? "arb" : "user";
    };

    const step = (t: number, dt: number) => {
      if (t >= nextBlock) spawnBlock(t);
      const v = w / CROSS_MS;
      const gx = w * GATE;
      for (let i = swaps.length - 1; i >= 0; i--) {
        const s = swaps[i];
        s.px = s.x;
        s.py = s.y;
        s.x += v * dt;
        if (!s.sorted && s.x >= gx) {
          s.sorted = true;
          gateFlash = 1;
          gateArb = s.arb;
        }
        if (s.sorted) s.y = s.y0 + (s.lane - s.y0) * ease((s.x - gx) / (w * 0.2));
        if (s.x > w + 12) {
          settle(s);
          swaps.splice(i, 1);
        }
      }
      gateFlash = Math.max(0, gateFlash - dt / 380);
    };

    // start mid-flow, so the stage is never empty when it first comes into view; the score starts from zero
    for (let t = 0; t < CROSS_MS * 1.2; t += 16) step(t, 16);
    fees = loss = credit = 0;
    const warm = CROSS_MS * 1.2;

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // no motion: run the flow for a while off-screen and show one still frame of it
      for (let t = warm; t < 40_000; t += 16) step(t, 16);
      draw();
      paintNumbers();
      return () => ro.disconnect();
    }

    let raf = 0;
    let last = 0;
    let clock = warm;
    let lastPaint = 0;
    let lastColours = 0;
    let visible = false;
    const frame = (now: number) => {
      raf = 0;
      const dt = last ? Math.min(50, now - last) : 16;
      last = now;
      clock += dt;
      step(clock, dt);
      draw();
      if (clock - lastPaint > 90) {
        paintNumbers();
        lastPaint = clock;
      }
      if (clock - lastColours > 800) {
        readColours();
        lastColours = clock;
      }
      if (visible && !document.hidden) raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (!raf && visible && !document.hidden) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      start();
    });
    io.observe(canvas);
    const onVis = () => start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="sorter">
      <div className="sorter-stage">
        <canvas ref={canvasRef} aria-hidden />
        <span className="sorter-tag in">
          Swaps arrive · <span ref={blockRef}>block 0</span>
        </span>
        <div className="sorter-gate" ref={gateRef} style={{ left: `${GATE * 100}%` }}>
          <b>UkiyoHook</b>
          <span>tip ≥ threshold?</span>
        </div>
        <span className="sorter-tag arb">
          <b>Arbitrage</b> <span className="tail">paid to go first · </span>charged as loss
        </span>
        <span className="sorter-tag user">
          <b>Users</b> <span className="tail">no tip · fees and impact </span>credited
        </span>
      </div>
      <div className="sorter-score">
        <div>
          <span>Fee income</span>
          <b ref={feeRef}>$0</b>
          <small>what fee APR ranks by: every swap&apos;s fee</small>
        </div>
        <div>
          <span>Arbitrage loss</span>
          <b ref={lossRef} className="neg">−$0</b>
          <small>what the tipped swaps took</small>
        </div>
        <div className="edge">
          <span>Edge</span>
          <b ref={edgeRef}>+$0</b>
          <small>user fees + user impact − arbitrage loss</small>
        </div>
      </div>
    </div>
  );
}

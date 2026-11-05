import { useEffect, useRef } from "react";

import { gsap, prefersReducedMotion } from "@/lib/motion";

/**
 * EmberField — the page's ambient weather.
 *
 * Reads the global `--heat` custom property (0 cold … 1 white hot) every
 * frame. Above peg the field is embers: warm, rising, quickening. Below peg it
 * turns to ash: grey flakes drifting *down*. Nobody has to read a chart to
 * feel which way the protocol is leaning.
 *
 * Runs on gsap.ticker, pauses when the tab is hidden, caps DPR at 2 and
 * draws a single static frame under prefers-reduced-motion.
 */

interface Mote {
  x: number;
  y: number;
  r: number;
  speed: number;
  drift: number;
  phase: number;
  life: number;
}

function readHeat(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--heat"));
  return isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
}

export function EmberField({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0;
    let h = 0;
    const motes: Mote[] = [];

    function spawn(m?: Mote, anywhere = false): Mote {
      const heat = readHeat();
      const rising = heat >= 0.42;
      const mote = m ?? ({} as Mote);
      mote.x = Math.random() * w;
      mote.y = anywhere ? Math.random() * h : rising ? h + 10 : -10;
      mote.r = (Math.random() * 1.6 + 0.5) * dpr;
      mote.speed = (Math.random() * 0.6 + 0.25) * dpr;
      mote.drift = (Math.random() - 0.5) * 0.4 * dpr;
      mote.phase = Math.random() * Math.PI * 2;
      mote.life = Math.random();
      return mote;
    }

    function resize() {
      if (!canvas) return;
      w = canvas.width = Math.floor(canvas.clientWidth * dpr);
      h = canvas.height = Math.floor(canvas.clientHeight * dpr);
      const target = window.innerWidth < 768 ? 34 : 72;
      motes.length = 0;
      for (let i = 0; i < target; i++) motes.push(spawn(undefined, true));
    }

    function draw(stepScale = 1) {
      if (!ctx) return;
      const heat = readHeat();
      const rising = heat >= 0.42;
      // Intensity curve: cold side still shows ash, hot side gets brighter + faster.
      const tempo = rising ? 0.6 + (heat - 0.42) * 2.6 : 0.35 + (0.42 - heat) * 0.6;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";

      for (const m of motes) {
        m.phase += 0.02 * stepScale;
        m.life += 0.0025 * stepScale;
        const sway = Math.sin(m.phase) * 0.6 * dpr;
        m.x += (m.drift + sway * 0.25) * stepScale;
        m.y += (rising ? -1 : 1) * m.speed * tempo * stepScale;

        if (m.y < -20 || m.y > h + 20 || m.x < -20 || m.x > w + 20) spawn(m);

        const flicker = 0.55 + Math.sin(m.phase * 3) * 0.25;
        let r: number, g: number, b: number, a: number;
        if (rising) {
          // ember → white-hot as heat climbs
          const t = (heat - 0.42) / 0.58;
          r = 255;
          g = Math.round(90 + t * 120);
          b = Math.round(31 + t * 90);
          a = (0.35 + t * 0.4) * flicker;
        } else {
          r = g = b = 150;
          a = 0.22 * flicker;
        }
        const radius = m.r * (rising ? 1 + heat * 0.6 : 1.1);
        const grad = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, radius * 4);
        grad.addColorStop(0, `rgba(${r},${g},${b},${a})`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(m.x, m.y, radius * 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
    }

    resize();
    window.addEventListener("resize", resize);

    if (prefersReducedMotion()) {
      draw();
      return () => window.removeEventListener("resize", resize);
    }

    const tick = (_t: number, deltaMs: number) => draw(Math.min(deltaMs / 16.67, 3));
    gsap.ticker.add(tick);

    function visibility() {
      if (document.hidden) gsap.ticker.remove(tick);
      else gsap.ticker.add(tick);
    }
    document.addEventListener("visibilitychange", visibility);

    return () => {
      gsap.ticker.remove(tick);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className={`pointer-events-none h-full w-full ${className}`} />;
}

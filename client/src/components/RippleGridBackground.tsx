import { useEffect, useRef } from "react";

// Single-octave noise — one sin + one cos per call
function noise(x: number, y: number, t: number): number {
  return Math.sin(x * 0.01 + t) * Math.cos(y * 0.015 + t * 0.7);
}

// Two-octave layered noise
function layeredNoise(x: number, y: number, t: number): number {
  return noise(x, y, t) + noise(x * 2, y * 2, t * 1.3) * 0.5;
}

const RESOLUTION_SCALE = 0.75; // Render at reduced res, CSS scales up
const TARGET_FPS = 20;
const FRAME_INTERVAL = 1000 / TARGET_FPS;

export function RippleGridBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let time = 0;
    let lastFrameTime = 0;

    const speed = 0.3;
    const distortion = 2;
    const spacing = 55;
    const step = 14;
    const maxDimension = 4096;

    function resize() {
      const w = Math.min(window.innerWidth, maxDimension);
      const h = Math.min(window.innerHeight, maxDimension);

      // Render at half resolution
      canvas!.width = Math.round(w * RESOLUTION_SCALE);
      canvas!.height = Math.round(h * RESOLUTION_SCALE);
      canvas!.style.width = w + "px";
      canvas!.style.height = h + "px";

      const vv = window.visualViewport;
      if (vv) {
        canvas!.style.top = vv.offsetTop + "px";
        canvas!.style.left = vv.offsetLeft + "px";
      } else {
        canvas!.style.top = "0";
        canvas!.style.left = "0";
      }
    }

    resize();
    window.addEventListener("resize", resize, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", resize, { passive: true });
      window.visualViewport.addEventListener("scroll", resize, { passive: true });
    }

    function draw(now: number) {
      animId = requestAnimationFrame(draw);

      // Skip frame if tab is hidden or not enough time elapsed
      if (document.hidden) return;
      const delta = now - lastFrameTime;
      if (delta < FRAME_INTERVAL) return;
      lastFrameTime = now;

      const w = canvas!.width;
      const h = canvas!.height;
      const t = time * speed;

      ctx!.clearRect(0, 0, w, h);
      ctx!.strokeStyle = "rgba(139, 92, 246, 0.12)";
      ctx!.lineWidth = 0.8;

      const margin = spacing * RESOLUTION_SCALE;
      const scaledSpacing = spacing * RESOLUTION_SCALE;
      const scaledStep = step * RESOLUTION_SCALE;
      const distX = distortion * 8 * RESOLUTION_SCALE;
      const distY = distortion * 3 * RESOLUTION_SCALE;

      // Batch all vertical lines into one path
      ctx!.beginPath();
      for (let x = -margin; x <= w + margin; x += scaledSpacing) {
        // Scale coordinates back to world space for consistent noise
        const wx = x / RESOLUTION_SCALE;
        let first = true;
        for (let y = -margin; y <= h + margin; y += scaledStep) {
          const wy = y / RESOLUTION_SCALE;
          const n = layeredNoise(wx, wy, t);
          const ox = n * distX;
          const oy = n * distY * 0.6; // Derive oy from same noise, scaled differently
          if (first) {
            ctx!.moveTo(x + ox, y + oy);
            first = false;
          } else {
            ctx!.lineTo(x + ox, y + oy);
          }
        }
      }
      ctx!.stroke();

      // Batch all horizontal lines into one path
      ctx!.beginPath();
      for (let y = -margin; y <= h + margin; y += scaledSpacing) {
        const wy = y / RESOLUTION_SCALE;
        let first = true;
        for (let x = -margin; x <= w + margin; x += scaledStep) {
          const wx = x / RESOLUTION_SCALE;
          const n = layeredNoise(wx, wy, t);
          const ox = n * distX;
          const oy = n * distY * 0.6;
          if (first) {
            ctx!.moveTo(x + ox, y + oy);
            first = false;
          } else {
            ctx!.lineTo(x + ox, y + oy);
          }
        }
      }
      ctx!.stroke();

      time += delta * 0.0008;
    }

    animId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed pointer-events-none"
      style={{ left: 0, right: 0, top: 0, zIndex: 0 }}
    />
  );
}

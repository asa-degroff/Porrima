import { useEffect, useRef } from "react";

function noise(x: number, y: number, t: number): number {
  return (
    Math.sin(x * 0.01 + t) *
    Math.cos(y * 0.015 + t * 0.7) *
    Math.sin((x + y) * 0.005 + t * 0.5)
  );
}

function layeredNoise(x: number, y: number, t: number, octaves = 3): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    value += noise(x * frequency, y * frequency, t * (1 + i * 0.3)) * amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value;
}

export function RippleGridBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let time = 0;

    const speed = 0.3;
    const distortion = 2;
    const spacing = 45;
    const step = 6;

    function resize() {
      // Use the layout viewport height (window.innerHeight) which stays constant
      // with interactive-widget=overlays-content. This ensures the canvas covers
      // the full screen including the area behind the keyboard.
      canvas!.width = window.innerWidth;
      canvas!.height = window.innerHeight;
      // Position at the visual viewport's offset to match where content renders
      const vv = window.visualViewport;
      if (vv) {
        canvas!.style.top = vv.offsetTop + 'px';
        canvas!.style.left = vv.offsetLeft + 'px';
      } else {
        canvas!.style.top = '0';
        canvas!.style.left = '0';
      }
    }

    resize();
    window.addEventListener("resize", resize, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", resize, { passive: true });
      window.visualViewport.addEventListener("scroll", resize, { passive: true });
    }

    function draw() {
      const w = canvas!.width;
      const h = canvas!.height;

      // Clear fully — the CSS body gradient shows through
      ctx!.clearRect(0, 0, w, h);

      ctx!.strokeStyle = "rgba(139, 92, 246, 0.12)";
      ctx!.lineWidth = 0.8;

      // Vertical lines
      for (let x = 0; x <= w + spacing; x += spacing) {
        ctx!.beginPath();
        for (let y = 0; y <= h; y += step) {
          const n = layeredNoise(x, y, time * speed, 3);
          const ox = n * distortion * 8;
          const oy = layeredNoise(x * 0.7, y, time * speed * 0.8, 2) * distortion * 3;
          if (y === 0) {
            ctx!.moveTo(x + ox, y + oy);
          } else {
            ctx!.lineTo(x + ox, y + oy);
          }
        }
        ctx!.stroke();
      }

      // Horizontal lines
      for (let y = 0; y <= h + spacing; y += spacing) {
        ctx!.beginPath();
        for (let x = 0; x <= w; x += step) {
          const n = layeredNoise(x, y, time * speed, 3);
          const ox = n * distortion * 8;
          const oy = layeredNoise(x * 0.7, y, time * speed * 0.8, 2) * distortion * 3;
          if (x === 0) {
            ctx!.moveTo(x + ox, y + oy);
          } else {
            ctx!.lineTo(x + ox, y + oy);
          }
        }
        ctx!.stroke();
      }

      time += 0.016;
      animId = requestAnimationFrame(draw);
    }

    draw();

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

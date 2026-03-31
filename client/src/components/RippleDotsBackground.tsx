import { useEffect, useRef } from "react";

// Same noise algorithm as RippleGridBackground, but renders dots at grid intersections
// instead of continuous lines. Tighter spacing creates a denser dot field.

const RESOLUTION_SCALE = 0.75;
const TARGET_FPS = 20;
const FRAME_INTERVAL = 1000 / TARGET_FPS;

export function RippleDotsBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let animId = 0;
    let time = 0;
    let lastFrameTime = 0;
    let running = true;

    const speed = 0.3;
    const distortion = 2;
    const spacing = 35; // Tighter spacing than ripple grid (55)
    const step = 14;
    const maxDimension = 4096;
    const dotRadius = 1.5; // Small dots

    const scaledSpacing = spacing * RESOLUTION_SCALE;
    const scaledStep = step * RESOLUTION_SCALE;
    const margin = scaledSpacing;
    const dX = distortion * 8 * RESOLUTION_SCALE;
    const dY = distortion * 3 * RESOLUTION_SCALE * 0.6;
    const invScale = 1 / RESOLUTION_SCALE;

    // Pre-allocated typed arrays
    let yPos: Float32Array;
    let cy1: Float32Array;
    let cy2: Float32Array;
    let xPos: Float32Array;
    let sx1: Float32Array;
    let sx2: Float32Array;
    let numX = 0;
    let numY = 0;
    let canvasW = 0;
    let canvasH = 0;

    // Grid intersection points
    let gridPointsX: Float32Array;
    let gridPointsY: Float32Array;
    let numPoints = 0;

    function resize() {
      const w = Math.min(window.innerWidth, maxDimension);
      const h = Math.min(window.innerHeight, maxDimension);

      canvasW = Math.round(w * RESOLUTION_SCALE);
      canvasH = Math.round(h * RESOLUTION_SCALE);
      canvas!.width = canvasW;
      canvas!.height = canvasH;
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

      const xStart = -margin;
      const xEnd = canvasW + margin;
      const yStart = -margin;
      const yEnd = canvasH + margin;

      numY = Math.floor((yEnd - yStart) / scaledStep) + 1;
      yPos = new Float32Array(numY);
      cy1 = new Float32Array(numY);
      cy2 = new Float32Array(numY);
      for (let i = 0; i < numY; i++) {
        yPos[i] = yStart + i * scaledStep;
      }

      numX = Math.floor((xEnd - xStart) / scaledStep) + 1;
      xPos = new Float32Array(numX);
      sx1 = new Float32Array(numX);
      sx2 = new Float32Array(numX);
      for (let i = 0; i < numX; i++) {
        xPos[i] = xStart + i * scaledStep;
      }

      // Pre-calculate grid intersection points (where dots will be drawn)
      const maxPoints = Math.floor((xEnd - xStart) / scaledSpacing) * 
                        Math.floor((yEnd - yStart) / scaledSpacing) + 100;
      gridPointsX = new Float32Array(maxPoints);
      gridPointsY = new Float32Array(maxPoints);
      numPoints = 0;
      
      for (let x = xStart; x <= xEnd; x += scaledSpacing) {
        for (let y = yStart; y <= yEnd; y += scaledSpacing) {
          gridPointsX[numPoints] = x;
          gridPointsY[numPoints] = y;
          numPoints++;
        }
      }

      ctx!.lineWidth = 0.8;
    }

    resize();
    window.addEventListener("resize", resize, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", resize, {
        passive: true,
      });
      window.visualViewport.addEventListener("scroll", resize, {
        passive: true,
      });
    }

    function onVisibilityChange() {
      if (document.hidden) {
        if (animId) {
          cancelAnimationFrame(animId);
          animId = 0;
        }
      } else if (running && !animId) {
        lastFrameTime = 0;
        animId = requestAnimationFrame(draw);
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    function draw(now: number) {
      animId = requestAnimationFrame(draw);

      const delta = now - lastFrameTime;
      if (delta < FRAME_INTERVAL) return;
      lastFrameTime = now;

      const computedStyle = getComputedStyle(document.documentElement);
      const gridRgb = computedStyle.getPropertyValue('--theme-grid').trim();
      const gridOpacity = computedStyle.getPropertyValue('--theme-grid-opacity').trim() || '0.12';
      ctx!.fillStyle = `rgba(${gridRgb}, ${gridOpacity})`;

      const t = time * speed;
      const t07 = t * 0.7;
      const t13 = t * 1.3;
      const t091 = t07 * 1.3;

      // Update precomputed trig arrays
      for (let i = 0; i < numY; i++) {
        const wy = yPos[i] * invScale;
        cy1[i] = Math.cos(wy * 0.015 + t07);
        cy2[i] = Math.cos(wy * 0.03 + t091);
      }
      for (let i = 0; i < numX; i++) {
        const wx = xPos[i] * invScale;
        sx1[i] = Math.sin(wx * 0.01 + t);
        sx2[i] = Math.sin(wx * 0.02 + t13);
      }

      ctx!.clearRect(0, 0, canvasW, canvasH);

      // Draw dots at grid intersections with wave distortion
      // We need to interpolate noise values at each grid point
      for (let i = 0; i < numPoints; i++) {
        const baseX = gridPointsX[i];
        const baseY = gridPointsY[i];
        const wx = baseX * invScale;
        const wy = baseY * invScale;

        // Find nearest precomputed indices for interpolation
        const xIdx = Math.floor((wx - xPos[0] * invScale) / (scaledStep * invScale));
        const yIdx = Math.floor((wy - yPos[0] * invScale) / (scaledStep * invScale));

        // Clamp to valid range
        const xIdxClamped = Math.max(0, Math.min(numX - 1, xIdx));
        const yIdxClamped = Math.max(0, Math.min(numY - 1, yIdx));

        // Get noise from precomputed arrays
        const lineSx1 = sx1[xIdxClamped];
        const lineSx2 = sx2[xIdxClamped];
        const lineCy1 = cy1[yIdxClamped];
        const lineCy2 = cy2[yIdxClamped];

        // Calculate noise at this point
        const n = lineSx1 * lineCy1 + lineSx2 * lineCy2 * 0.5;
        
        // Apply distortion
        const px = baseX + n * dX;
        const py = baseY + n * dY;

        // Draw dot
        ctx!.beginPath();
        ctx!.arc(px, py, dotRadius, 0, Math.PI * 2);
        ctx!.fill();
      }

      time += delta * 0.0008;
    }

    animId = requestAnimationFrame(draw);

    return () => {
      running = false;
      if (animId) cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", resize);
        window.visualViewport.removeEventListener("scroll", resize);
      }
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

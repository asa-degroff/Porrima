import { useEffect, useRef } from "react";

// Noise is separable: noise(x,y,t) = sin(x*0.01+t) * cos(y*0.015+t*0.7)
// layeredNoise = sin(x*0.01+t)*cos(y*0.015+t*0.7) + sin(x*0.02+t*1.3)*cos(y*0.03+t*0.91)*0.5
// We precompute 1D sin/cos arrays and combine with multiply-add in inner loops,
// reducing ~25k trig calls per frame to ~600.

const RESOLUTION_SCALE = 0.75; // Render at reduced res, CSS scales up
const TARGET_FPS = 20;
const FRAME_INTERVAL = 1000 / TARGET_FPS;

export function RippleGridBackground() {
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
    const spacing = 55;
    const step = 14;
    const maxDimension = 4096;

    const scaledSpacing = spacing * RESOLUTION_SCALE;
    const scaledStep = step * RESOLUTION_SCALE;
    const margin = scaledSpacing;
    const dX = distortion * 8 * RESOLUTION_SCALE;
    const dY = distortion * 3 * RESOLUTION_SCALE * 0.6;
    const invScale = 1 / RESOLUTION_SCALE;

    // Pre-allocated typed arrays, resized only on resize
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

    // Pre-allocate arrays for vertical/horizontal line x/y positions
    let vLineXs: Float32Array;
    let numVLines = 0;
    let hLineYs: Float32Array;
    let numHLines = 0;

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

      // Recompute array sizes and pre-allocate
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

      // Pre-allocate vertical line x positions
      numVLines = 0;
      const maxVLines = Math.floor((xEnd - xStart) / scaledSpacing) + 2;
      vLineXs = new Float32Array(maxVLines);
      for (let x = xStart; x <= xEnd; x += scaledSpacing) {
        vLineXs[numVLines++] = x;
      }

      // Pre-allocate horizontal line y positions
      numHLines = 0;
      const maxHLines = Math.floor((yEnd - yStart) / scaledSpacing) + 2;
      hLineYs = new Float32Array(maxHLines);
      for (let y = yStart; y <= yEnd; y += scaledSpacing) {
        hLineYs[numHLines++] = y;
      }

      // Canvas dimension changes reset context state, so re-apply
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

    // Pause/resume on visibility change instead of checking document.hidden every frame
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

    // Radial chromatic aberration offset, computed per point with quadratic falloff.
    // `sign` is +1 for outward (red) and -1 for inward (blue).
    function drawGrid(strength: number, sign: number, cx: number, cy: number, invMaxR2: number) {
      const hasAberration = strength !== 0;

      // Vertical lines: sin(x) is constant per line, cos(y) is precomputed
      ctx!.beginPath();
      for (let li = 0; li < numVLines; li++) {
        const x = vLineXs[li];
        const wx = x * invScale;
        const lineSx1 = Math.sin(wx * 0.01 + t);
        const lineSx2 = Math.sin(wx * 0.02 + t13);
        for (let i = 0; i < numY; i++) {
          const n = lineSx1 * cy1[i] + lineSx2 * cy2[i] * 0.5;
          let px = x + n * dX;
          let py = yPos[i] + n * dY;
          if (hasAberration) {
            const ddx = px - cx;
            const ddy = py - cy;
            const d2 = ddx * ddx + ddy * ddy;
            const f = (d2 * invMaxR2) * strength * sign / (Math.sqrt(d2) + 1e-6);
            px += ddx * f;
            py += ddy * f;
          }
          if (i === 0) ctx!.moveTo(px, py);
          else ctx!.lineTo(px, py);
        }
      }
      ctx!.stroke();

      // Horizontal lines: cos(y) is constant per line, sin(x) is precomputed
      ctx!.beginPath();
      for (let li = 0; li < numHLines; li++) {
        const y = hLineYs[li];
        const wy = y * invScale;
        const lineCy1 = Math.cos(wy * 0.015 + t07);
        const lineCy2 = Math.cos(wy * 0.03 + t091);
        for (let i = 0; i < numX; i++) {
          const n = sx1[i] * lineCy1 + sx2[i] * lineCy2 * 0.5;
          let px = xPos[i] + n * dX;
          let py = y + n * dY;
          if (hasAberration) {
            const ddx = px - cx;
            const ddy = py - cy;
            const d2 = ddx * ddx + ddy * ddy;
            const f = (d2 * invMaxR2) * strength * sign / (Math.sqrt(d2) + 1e-6);
            px += ddx * f;
            py += ddy * f;
          }
          if (i === 0) ctx!.moveTo(px, py);
          else ctx!.lineTo(px, py);
        }
      }
      ctx!.stroke();
    }

    let t = 0;
    let t07 = 0;
    let t13 = 0;
    let t091 = 0;

    function draw(now: number) {
      animId = requestAnimationFrame(draw);

      const delta = now - lastFrameTime;
      if (delta < FRAME_INTERVAL) return;
      lastFrameTime = now;

      // Read theme values from CSS custom properties every frame to support theme switching
      const computedStyle = getComputedStyle(document.documentElement);
      const gridRgb = computedStyle.getPropertyValue('--theme-grid').trim();
      const gridOpacity = parseFloat(computedStyle.getPropertyValue('--theme-grid-opacity').trim() || '0.12');
      const aberrationCssPx = parseFloat(computedStyle.getPropertyValue('--theme-aberration-strength').trim() || '0');
      const aberrationStr = aberrationCssPx * RESOLUTION_SCALE;

      t = time * speed;
      t07 = t * 0.7;
      t13 = t * 1.3;
      t091 = t07 * 1.3;

      // Update precomputed trig arrays (reuses existing buffers, no allocation)
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

      const cx = canvasW * 0.5;
      const cy = canvasH * 0.5;
      const invMaxR2 = 1 / (cx * cx + cy * cy);

      // Base pass: theme color, no offset
      ctx!.globalCompositeOperation = 'source-over';
      ctx!.strokeStyle = `rgba(${gridRgb}, ${gridOpacity})`;
      drawGrid(0, 0, cx, cy, invMaxR2);

      // Chromatic aberration: additive red (outward) + blue (inward) passes
      if (aberrationStr > 0) {
        const fringeOpacity = gridOpacity * 0.6;
        ctx!.globalCompositeOperation = 'lighter';
        ctx!.strokeStyle = `rgba(255, 40, 40, ${fringeOpacity})`;
        drawGrid(aberrationStr, +1, cx, cy, invMaxR2);
        ctx!.strokeStyle = `rgba(40, 90, 255, ${fringeOpacity})`;
        drawGrid(aberrationStr, -1, cx, cy, invMaxR2);
        ctx!.globalCompositeOperation = 'source-over';
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

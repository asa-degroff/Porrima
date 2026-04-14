import { useEffect, useRef } from "react";

// Optimized dot-field variant of the ripple wave animation.
// Key optimizations vs naive approach:
// - fillRect instead of arc (no path overhead for sub-3px dots)
// - Precomputed grid-to-noise-sample index mapping (no per-frame division)
// - Precomputed world-space coordinates (no per-frame invScale multiply)
// - Same separable noise trick as RippleGrid: ~600 trig calls total,
//   then simple multiply-add per dot

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
    const spacing = 35;
    const step = 14;
    const maxDimension = 4096;
    const dotSize = 3; // fillRect size (covers dotRadius=1.5 on each side)

    const scaledSpacing = spacing * RESOLUTION_SCALE;
    const scaledStep = step * RESOLUTION_SCALE;
    const margin = scaledSpacing;
    const dX = distortion * 8 * RESOLUTION_SCALE;
    const dY = distortion * 3 * RESOLUTION_SCALE * 0.6;
    const invScale = 1 / RESOLUTION_SCALE;

    // Noise sample arrays (same scheme as RippleGrid)
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

    // Precomputed grid points with index mapping
    // Each entry: [renderX, renderY, noiseXIdx, noiseYIdx]
    let gridRenderX: Float32Array;
    let gridRenderY: Float32Array;
    let gridNoiseXIdx: Int32Array;
    let gridNoiseYIdx: Int32Array;
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

      // Noise sample arrays
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

      // Precompute grid intersection points with their noise sample indices
      const maxPoints =
        Math.ceil((xEnd - xStart) / scaledSpacing) *
        Math.ceil((yEnd - yStart) / scaledSpacing) + 10;

      gridRenderX = new Float32Array(maxPoints);
      gridRenderY = new Float32Array(maxPoints);
      gridNoiseXIdx = new Int32Array(maxPoints);
      gridNoiseYIdx = new Int32Array(maxPoints);
      numPoints = 0;

      const stepInverted = 1 / (scaledStep * invScale);

      for (let x = xStart; x <= xEnd; x += scaledSpacing) {
        const wx = x * invScale;
        // Map world X to nearest noise sample index (precomputed, no division in draw)
        const xi = Math.round((wx - xPos[0] * invScale) * stepInverted);
        const xIdx = Math.max(0, Math.min(numX - 1, xi));

        for (let y = yStart; y <= yEnd; y += scaledSpacing) {
          const wy = y * invScale;
          const yi = Math.round((wy - yPos[0] * invScale) * stepInverted);
          const yIdx = Math.max(0, Math.min(numY - 1, yi));

          gridRenderX[numPoints] = x;
          gridRenderY[numPoints] = y;
          gridNoiseXIdx[numPoints] = xIdx;
          gridNoiseYIdx[numPoints] = yIdx;
          numPoints++;
        }
      }
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

    // Mouse-warp state: the ripple center lerps toward the cursor each frame
    // so fast movement drags the distortion smoothly through intermediate
    // positions. A decaying trail of breadcrumbs is dropped along the way so
    // earlier positions keep rippling briefly — like a wake through water.
    const WARP_FOLLOW = 0.2;
    const TRAIL_CAPACITY = 5;
    const TRAIL_MIN_DIST = 40 * RESOLUTION_SCALE;
    const TRAIL_MIN_DIST_SQ = TRAIL_MIN_DIST * TRAIL_MIN_DIST;
    const TRAIL_DECAY = 0.88;
    const TRAIL_EPSILON = 0.03;
    let targetMouseX = 0;
    let targetMouseY = 0;
    let committedMouseX = 0;
    let committedMouseY = 0;
    let warpTargetGate = 0;
    let warpGate = 0;
    let mouseEverSeen = false;

    // Trail ring buffer (breadcrumbs along the cursor's path)
    const trailX = new Float32Array(TRAIL_CAPACITY);
    const trailY = new Float32Array(TRAIL_CAPACITY);
    const trailS = new Float32Array(TRAIL_CAPACITY);
    let trailLen = 0;
    let lastDropX = 0;
    let lastDropY = 0;
    let hasDrop = false;

    // Active warp centers each frame (primary lerped point + alive trail)
    const CENTER_CAPACITY = TRAIL_CAPACITY + 1;
    const centerX = new Float32Array(CENTER_CAPACITY);
    const centerY = new Float32Array(CENTER_CAPACITY);
    const centerS = new Float32Array(CENTER_CAPACITY);
    let numCenters = 0;

    function onMouseMove(e: MouseEvent) {
      targetMouseX = e.clientX * RESOLUTION_SCALE;
      targetMouseY = e.clientY * RESOLUTION_SCALE;
      if (!mouseEverSeen) {
        committedMouseX = targetMouseX;
        committedMouseY = targetMouseY;
        mouseEverSeen = true;
      }
      warpTargetGate = 1;
    }
    function onMouseLeave() {
      warpTargetGate = 0;
    }
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    document.addEventListener("mouseleave", onMouseLeave);
    window.addEventListener("blur", onMouseLeave);

    // Per-frame warp params (populated in draw(), read by drawDots)
    let warpActive = false;
    let warpRadius = 0;
    let warpR2 = 0;
    let warpEffStrength = 0;

    // Radial chromatic aberration + mouse-warp per dot.
    // aberration sign = +1 outward (red), -1 inward (blue), 0 = no offset (base pass).
    function drawDots(strength: number, sign: number, cx: number, cy: number, invMaxR2: number, halfDot: number) {
      const hasAberration = strength !== 0;
      for (let i = 0; i < numPoints; i++) {
        const n = sx1[gridNoiseXIdx[i]] * cy1[gridNoiseYIdx[i]] +
                  sx2[gridNoiseXIdx[i]] * cy2[gridNoiseYIdx[i]] * 0.5;
        let px = gridRenderX[i] + n * dX;
        let py = gridRenderY[i] + n * dY;
        if (warpActive) {
          // Blend overlapping ripples as a weighted average of push vectors,
          // weighted by each center's influence (s²·strength). Prevents two
          // overlapping ripples from producing an additive double-bump.
          let sumPX = 0, sumPY = 0, sumW = 0;
          for (let k = 0; k < numCenters; k++) {
            const mdx = px - centerX[k];
            const mdy = py - centerY[k];
            const md2 = mdx * mdx + mdy * mdy;
            if (md2 < warpR2) {
              const md = Math.sqrt(md2);
              // sin²(π·t) bump: 0 at cursor, peaks mid-radius, 0 at edge.
              // Zero derivative at t=0 eliminates the flip artifact near the cursor.
              const s = Math.sin(Math.PI * md / warpRadius);
              const inf = s * s * centerS[k];
              const pushMag = inf * warpEffStrength / (md + 1e-6);
              sumPX += mdx * pushMag * inf;
              sumPY += mdy * pushMag * inf;
              sumW += inf;
            }
          }
          if (sumW > 0) {
            px += sumPX / sumW;
            py += sumPY / sumW;
          }
        }
        if (hasAberration) {
          const ddx = px - cx;
          const ddy = py - cy;
          const d2 = ddx * ddx + ddy * ddy;
          const f = (d2 * invMaxR2) * strength * sign / (Math.sqrt(d2) + 1e-6);
          px += ddx * f;
          py += ddy * f;
        }
        ctx!.fillRect(px - halfDot, py - halfDot, dotSize, dotSize);
      }
    }

    function draw(now: number) {
      animId = requestAnimationFrame(draw);

      const delta = now - lastFrameTime;
      if (delta < FRAME_INTERVAL) return;
      lastFrameTime = now;

      const computedStyle = getComputedStyle(document.documentElement);
      const gridRgb = computedStyle.getPropertyValue('--theme-grid').trim();
      const gridOpacity = parseFloat(computedStyle.getPropertyValue('--theme-grid-opacity').trim() || '0.12');
      const aberrationCssPx = parseFloat(computedStyle.getPropertyValue('--theme-aberration-strength').trim() || '0');
      const aberrationStr = aberrationCssPx * RESOLUTION_SCALE;
      const warpRadiusCssPx = parseFloat(computedStyle.getPropertyValue('--theme-warp-radius').trim() || '0');
      const warpStrengthCssPx = parseFloat(computedStyle.getPropertyValue('--theme-warp-strength').trim() || '0');

      if (mouseEverSeen) {
        committedMouseX += (targetMouseX - committedMouseX) * WARP_FOLLOW;
        committedMouseY += (targetMouseY - committedMouseY) * WARP_FOLLOW;
      }
      warpGate += (warpTargetGate - warpGate) * 0.08;

      // Drop a trail breadcrumb when the primary has moved far enough.
      // Gated by warpGate so we don't seed trail while the cursor is leaving.
      if (mouseEverSeen && warpGate > 0.5) {
        if (!hasDrop) {
          lastDropX = committedMouseX;
          lastDropY = committedMouseY;
          hasDrop = true;
        } else {
          const ddx = committedMouseX - lastDropX;
          const ddy = committedMouseY - lastDropY;
          if (ddx * ddx + ddy * ddy > TRAIL_MIN_DIST_SQ) {
            if (trailLen < TRAIL_CAPACITY) {
              trailX[trailLen] = committedMouseX;
              trailY[trailLen] = committedMouseY;
              trailS[trailLen] = 1;
              trailLen++;
            } else {
              for (let k = 0; k < TRAIL_CAPACITY - 1; k++) {
                trailX[k] = trailX[k + 1];
                trailY[k] = trailY[k + 1];
                trailS[k] = trailS[k + 1];
              }
              trailX[TRAIL_CAPACITY - 1] = committedMouseX;
              trailY[TRAIL_CAPACITY - 1] = committedMouseY;
              trailS[TRAIL_CAPACITY - 1] = 1;
            }
            lastDropX = committedMouseX;
            lastDropY = committedMouseY;
          }
        }
      }

      // Decay trail and compact in-place
      {
        let w = 0;
        for (let r = 0; r < trailLen; r++) {
          const s = trailS[r] * TRAIL_DECAY;
          if (s >= TRAIL_EPSILON) {
            trailX[w] = trailX[r];
            trailY[w] = trailY[r];
            trailS[w] = s;
            w++;
          }
        }
        trailLen = w;
      }

      // Assemble active centers: primary (if cursor present) + trail
      numCenters = 0;
      if (mouseEverSeen && warpGate > 0.01) {
        centerX[numCenters] = committedMouseX;
        centerY[numCenters] = committedMouseY;
        centerS[numCenters] = warpGate;
        numCenters++;
      }
      for (let k = 0; k < trailLen; k++) {
        centerX[numCenters] = trailX[k];
        centerY[numCenters] = trailY[k];
        centerS[numCenters] = trailS[k];
        numCenters++;
      }

      warpRadius = warpRadiusCssPx * RESOLUTION_SCALE;
      warpR2 = warpRadius * warpRadius;
      warpEffStrength = warpStrengthCssPx * RESOLUTION_SCALE;
      warpActive = numCenters > 0 && warpR2 > 0 && warpEffStrength > 0;

      const t = time * speed;
      const t07 = t * 0.7;
      const t13 = t * 1.3;
      const t091 = t07 * 1.3;

      // Update precomputed trig arrays (~600 trig calls total)
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
      const halfDot = dotSize * 0.5;

      // Base pass: theme color, no offset
      ctx!.globalCompositeOperation = 'source-over';
      ctx!.fillStyle = `rgba(${gridRgb}, ${gridOpacity})`;
      drawDots(0, 0, cx, cy, invMaxR2, halfDot);

      // Chromatic aberration: additive red (outward) + blue (inward) passes
      if (aberrationStr > 0) {
        const fringeOpacity = gridOpacity * 0.6;
        ctx!.globalCompositeOperation = 'lighter';
        ctx!.fillStyle = `rgba(255, 40, 40, ${fringeOpacity})`;
        drawDots(aberrationStr, +1, cx, cy, invMaxR2, halfDot);
        ctx!.fillStyle = `rgba(40, 90, 255, ${fringeOpacity})`;
        drawDots(aberrationStr, -1, cx, cy, invMaxR2, halfDot);
        ctx!.globalCompositeOperation = 'source-over';
      }

      time += delta * 0.0008;
    }

    animId = requestAnimationFrame(draw);

    return () => {
      running = false;
      if (animId) cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("blur", onMouseLeave);
      document.removeEventListener("mouseleave", onMouseLeave);
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
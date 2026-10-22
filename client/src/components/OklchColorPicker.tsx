import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Oklch } from "../utils/oklch";
import {
  clampChroma,
  contrastRatio,
  hexToOklch,
  inSrgbGamut,
  lightnessForLuminance,
  linearSrgbToUnit,
  maxChroma,
  oklchToHex,
  oklchToLinearSrgb,
  relativeLuminanceHex,
  relativeLuminanceRgb,
} from "../utils/oklch";
import { CUSTOM_THEME_MAX_BACKGROUND_LUMINANCE, normalizeHexColor } from "../utils/custom-theme";

// The plane maps x to chroma (0 at the left, PLANE_CHROMA_MAX at the right)
// and y to lightness (0 at the bottom, 1 at the top). It renders at a fixed
// internal resolution and scales with its container; pointer mapping uses the
// bounding rect, so the CSS scaling is transparent. Resolution trades against
// the per-hue-change re-render cost (the hue slider re-renders it on every
// drag step), so it stays modest — the surface is a smooth gradient.
const PLANE_WIDTH = 480;
const PLANE_HEIGHT = 300;
const PLANE_CHROMA_MAX = 0.35;

// Surface color where the gamut does not reach, with a faint ghost of the
// clamped color so the hue direction still reads.
const OUT_OF_GAMUT_BASE: readonly [number, number, number] = [15, 16, 20];
const OUT_OF_GAMUT_GHOST = 0.22;

// Highest lightness whose neutral gray still passes the dark-background
// luminance gate (WCAG relative luminance). Computed, not eyeballed: OKLab L
// is not CIELAB L*/100 at mid tones.
const DARK_BG_MAX_L = lightnessForLuminance(CUSTOM_THEME_MAX_BACKGROUND_LUMINANCE);

// Slider styling shared with the settings UI's color sliders (Activity
// Spinner block): gradient track, white round thumb. min-w-0 lets the native
// range input (which has an intrinsic minimum width) shrink inside flex rows
// instead of overflowing its container.
const SLIDER_CLASSES =
  "flex-1 min-w-0 h-2 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white/80 [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white/30 [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white/80 [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white/30 [&::-moz-range-thumb]:shadow-md [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-track]:transparent";

const HUE_TRACK = `linear-gradient(to right, ${Array.from({ length: 13 }, (_, i) => `oklch(0.7 0.25 ${i * 30})`).join(", ")})`;

// Ink for the label and hex readout, which ride on a swatch bar painted with
// the color the user is choosing — a color this component cannot constrain
// (the accent control has no luminance gate at all). So the ink is picked per
// swatch by WCAG contrast rather than fixed.
//
// The pair is chosen so the rule never has a blind spot: white ink and dark
// ink reach equal contrast at a swatch luminance of sqrt(1.05 × (darkLum +
// 0.05)) − 0.05, and that common contrast is the floor of the whole rule. At
// #05060a the floor is 4.50:1 — WCAG AA — so the bar stays legible for every
// selectable color, not merely most of them. A softer dark ink (#0b0d12, the
// app's usual panel tint) would drop the floor to 4.41:1.
//
// The crossover lands at swatch luminance 0.1833, which is the same line as
// CUSTOM_THEME_MAX_BACKGROUND_LUMINANCE (0.183) — i.e. every background the
// dark control accepts takes light ink, and white ink is exactly at the AA
// floor at the very top of that range.
const INK_LIGHT = "#ffffff";
const INK_DARK = "#05060a";
const INK_DARK_LUMINANCE = relativeLuminanceHex(INK_DARK) ?? 0;

interface SwatchInk {
  /** Solid ink for the label and the hex readout. */
  color: string;
  /** "r,g,b" of that ink — the hairline classes build rgba() from it. */
  rgb: string;
  /** Hairline under the bar. A near-black background color would otherwise be
   *  indistinguishable from the card it sits in, since the card is itself a
   *  translucent panel over that same background. */
  boxShadow: string;
}

export function inkForSwatch(hex: string): SwatchInk {
  const luminance = relativeLuminanceHex(hex) ?? 0;
  const light =
    contrastRatio(1, luminance) >= contrastRatio(luminance, INK_DARK_LUMINANCE);
  return light
    ? { color: INK_LIGHT, rgb: "255,255,255", boxShadow: "inset 0 -1px 0 rgba(255,255,255,0.14)" }
    : { color: INK_DARK, rgb: "5,6,10", boxShadow: "inset 0 -1px 0 rgba(0,0,0,0.18)" };
}

interface OklchColorPickerProps {
  label: string;
  /** Current color as hex (the app's storage format). */
  value: string;
  /** Called with the new hex on every change. */
  onChange: (hex: string) => void;
  /** Constrain the lightness range and hatch the plane region that fails the
   *  dark-background luminance gate (the background color control). */
  darkOnly?: boolean;
}

export function OklchColorPicker({ label, value, onChange, darkOnly = false }: OklchColorPickerProps) {
  const [lch, setLch] = useState<Oklch>(() => hexToOklch(value));
  const [hexDraft, setHexDraft] = useState(value);
  // The color the app is rendering right now. The swatch bar paints this rather
  // than the field's draft: while a half-typed hex sits in the input, the bar
  // keeps reporting what is actually on screen.
  const [committedHex, setCommittedHex] = useState(() => normalizeHexColor(value) ?? value);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);
  // Last hex this control emitted; external value changes that differ from it
  // are parent-driven (preset load, reset) and re-sync the workspace.
  const lastEmittedRef = useRef(value);

  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    const normalized = normalizeHexColor(value);
    if (!normalized) return;
    lastEmittedRef.current = normalized;
    setLch(hexToOklch(normalized));
    setHexDraft(normalized);
    setCommittedHex(normalized);
  }, [value]);

  const chromaMax = maxChroma(lch.l, lch.h);

  const commit = (next: Oklch): void => {
    const lightness = Math.min(1, Math.max(0, next.l));
    const hue = ((next.h % 360) + 360) % 360;
    const chroma = clampChroma(lightness, hue, next.c);
    const hex = oklchToHex(lightness, chroma, hue);
    setLch({ l: lightness, c: chroma, h: hue });
    setHexDraft(hex);
    setCommittedHex(hex);
    lastEmittedRef.current = hex;
    if (hex !== value) onChange(hex);
  };

  // The plane only changes when the hue (or dark mode) changes; the cursor is
  // a DOM overlay, so drags never re-render the bitmap.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const image = context.createImageData(PLANE_WIDTH, PLANE_HEIGHT);
    const data = image.data;
    const hue = lch.h;
    let offset = 0;
    for (let y = 0; y < PLANE_HEIGHT; y += 1) {
      const lightness = 1 - y / (PLANE_HEIGHT - 1);
      for (let x = 0; x < PLANE_WIDTH; x += 1) {
        const chroma = (x / (PLANE_WIDTH - 1)) * PLANE_CHROMA_MAX;
        const srgb = linearSrgbToUnit(oklchToLinearSrgb(lightness, chroma, hue));
        let r = srgb.r * 255;
        let g = srgb.g * 255;
        let b = srgb.b * 255;
        if (!inSrgbGamut(lightness, chroma, hue)) {
          r = OUT_OF_GAMUT_BASE[0] + (r - OUT_OF_GAMUT_BASE[0]) * OUT_OF_GAMUT_GHOST;
          g = OUT_OF_GAMUT_BASE[1] + (g - OUT_OF_GAMUT_BASE[1]) * OUT_OF_GAMUT_GHOST;
          b = OUT_OF_GAMUT_BASE[2] + (b - OUT_OF_GAMUT_BASE[2]) * OUT_OF_GAMUT_GHOST;
        } else if (
          darkOnly &&
          relativeLuminanceRgb(srgb.r, srgb.g, srgb.b) > CUSTOM_THEME_MAX_BACKGROUND_LUMINANCE
        ) {
          // Hatch the region the WCAG gate rejects (a curved boundary — bright
          // hues fail it at lower lightness than neutrals do).
          if ((x + y) % 6 < 2) {
            r *= 0.45;
            g *= 0.45;
            b *= 0.45;
          }
        }
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
        data[offset + 3] = 255;
        offset += 4;
      }
    }
    context.putImageData(image, 0, 0);
  }, [lch.h, darkOnly]);

  const pointToLch = (event: ReactPointerEvent<HTMLCanvasElement>): Oklch => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    return { l: 1 - y, c: x * PLANE_CHROMA_MAX, h: lch.h };
  };

  const commitHexDraft = (): void => {
    const normalized = normalizeHexColor(hexDraft);
    if (normalized) {
      commit(hexToOklch(normalized));
    } else {
      setHexDraft(value);
    }
  };

  const lightnessMax = darkOnly ? DARK_BG_MAX_L : 1;
  const cursorLeft = (lch.c / PLANE_CHROMA_MAX) * 100;
  const cursorTop = (1 - lch.l) * 100;

  const ink = inkForSwatch(committedHex);
  const swatchStyle = {
    background: committedHex,
    color: ink.color,
    caretColor: ink.color,
    boxShadow: ink.boxShadow,
    "--ink-rgb": ink.rgb,
  } as CSSProperties;

  return (
    <div className="space-y-2.5 overflow-hidden rounded-md border border-white/10 bg-black/10 p-2.5">
      {/* The header doubles as the swatch, bleeding to the card's inner edges.
          Before this the selected color existed only as a position on the plane
          — a point inside a continuous field carries positional information,
          not color information. A flat field is the only honest readout of
          "this is what I picked", and on the background control it is also a
          literal preview of the surface the whole app sits on. The bar paints
          the committed color, not the field's draft, so it keeps telling the
          truth while a half-typed hex is in the input. */}
      <div
        data-testid="swatch"
        className="-mx-2.5 -mt-2.5 flex items-center justify-between gap-2 px-2.5 py-2"
        style={swatchStyle}
      >
        <span className="text-xs font-medium">{label}</span>
        <input
          value={hexDraft}
          onChange={(event) => setHexDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitHexDraft();
          }}
          onBlur={commitHexDraft}
          spellCheck={false}
          aria-label={`${label} hex value`}
          className="w-[4.5rem] rounded border border-[rgba(var(--ink-rgb),0.3)] bg-transparent px-2 py-0.5 text-right text-[11px] font-mono uppercase focus:border-[rgba(var(--ink-rgb),0.7)] focus:outline-none"
        />
      </div>

      <div className="relative overflow-hidden rounded-md border border-white/10 bg-black/40">
        <canvas
          ref={canvasRef}
          width={PLANE_WIDTH}
          height={PLANE_HEIGHT}
          aria-hidden="true"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            draggingRef.current = true;
            commit(pointToLch(event));
          }}
          onPointerMove={(event) => {
            if (draggingRef.current) commit(pointToLch(event));
          }}
          onPointerUp={() => {
            draggingRef.current = false;
          }}
          onPointerCancel={() => {
            draggingRef.current = false;
          }}
          className="block w-full cursor-crosshair touch-none select-none"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.7)]"
          style={{ left: `${cursorLeft}%`, top: `${cursorTop}%` }}
        />
      </div>

      <div className="flex items-center gap-2.5">
        <span className="w-3.5 font-mono text-[11px] text-white/40">H</span>
        <input
          type="range"
          min={0}
          max={360}
          step={1}
          value={Math.round(lch.h)}
          onChange={(event) => commit({ l: lch.l, c: lch.c, h: Number(event.target.value) })}
          aria-label={`${label} hue`}
          className={SLIDER_CLASSES}
          style={{ background: HUE_TRACK }}
        />
        <span className="w-9 text-right text-xs text-white/30 tabular-nums">{Math.round(lch.h)}°</span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex items-center gap-2.5">
          <span className="w-3.5 font-mono text-[11px] text-white/40">L</span>
          <input
            type="range"
            min={0}
            max={lightnessMax}
            step={0.001}
            value={lch.l}
            onChange={(event) => commit({ l: Number(event.target.value), c: lch.c, h: lch.h })}
            aria-label={`${label} lightness`}
            className={SLIDER_CLASSES}
            style={{ background: `linear-gradient(to right, oklch(0 ${lch.c} ${lch.h}), oklch(1 ${lch.c} ${lch.h}))` }}
          />
          <span className="w-8 text-right text-xs text-white/30 tabular-nums">{lch.l.toFixed(2)}</span>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="w-3.5 font-mono text-[11px] text-white/40">C</span>
          <input
            type="range"
            min={0}
            max={Math.max(chromaMax, 0.001)}
            step={0.001}
            value={Math.min(lch.c, chromaMax)}
            onChange={(event) => commit({ l: lch.l, c: Number(event.target.value), h: lch.h })}
            aria-label={`${label} chroma`}
            className={SLIDER_CLASSES}
            style={{ background: `linear-gradient(to right, oklch(${lch.l} 0 ${lch.h}), oklch(${lch.l} ${chromaMax} ${lch.h}))` }}
          />
          <span className="w-8 text-right text-xs text-white/30 tabular-nums">{lch.c.toFixed(2)}</span>
        </div>
      </div>

      {darkOnly && (
        <p className="text-[10px] text-white/25">Hatched area is too bright for the app's light text.</p>
      )}
    </div>
  );
}

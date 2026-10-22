import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles/glass.css";
import { OklchColorPicker, inkForSwatch } from "../src/components/OklchColorPicker";
import { getCustomThemeAccentContrast } from "../src/utils/custom-theme";

// Luminances chosen to straddle the ink crossover (swatch luminance ≈ 0.183)
// so the flip is visible at the point where white ink and dark ink are equally
// legible — the worst case for the whole rule.
const INK_LADDER = ["#0b0c10", "#1e1b4b", "#3f3f46", "#6b6b6b", "#808080", "#8d8d8d", "#a8a29e", "#fbbf24", "#f8fafc"];

// Pairs chosen to land on each side of both contrast thresholds: comfortable,
// accent-below-3 (borders vanish), and accent-clears-3-but-text-below-4.5.
const CONTRAST_PAIRS = [
  { background: "#1e1b4b", accent: "#fbbf24" },
  { background: "#1e1b4b", accent: "#111827" },
  { background: "#008474", accent: "#94dfd0" },
];

function Harness() {
  const [background, setBackground] = useState("#1e1b4b");
  const [accent, setAccent] = useState("#fbbf24");
  const pair = getCustomThemeAccentContrast(background, accent);
  return (
    <div className="wrap">
      <div className="swatch" style={{ background, color: "#fff" }}>
        Live preview — background <span className="mono">{background}</span> · accent{" "}
        <span className="mono">{accent}</span>
      </div>
      <OklchColorPicker
        label="Background"
        value={background}
        onChange={setBackground}
        contrastAgainst={accent}
        darkOnly
      />
      <OklchColorPicker label="Accent" value={accent} onChange={setAccent} contrastAgainst={background} />
      {pair.note && <div className="note">{pair.note}</div>}

      <div className="pairs">
        {CONTRAST_PAIRS.map(({ background: bg, accent: ac }) => {
          const p = getCustomThemeAccentContrast(bg, ac);
          return (
            <div key={`${bg}${ac}`} className="pair">
              <div className="pair-strip">
                <span className="half" style={{ background: bg, color: inkForSwatch(bg).color }}>{bg}</span>
                <span className="half" style={{ background: ac, color: inkForSwatch(ac).color }}>{ac}</span>
              </div>
              <div className="pair-meta">
                accent {p.accentRatio.toFixed(1)}:1 · text {p.textRatio.toFixed(1)}:1
                {p.note ? ` — ${p.note}` : " — clear"}
              </div>
            </div>
          );
        })}
      </div>

      <div id="ladder" className="ladder">
        {INK_LADDER.map((hex) => {
          const ink = inkForSwatch(hex);
          return (
            <div
              key={hex}
              className="ladder-row"
              style={{ background: hex, color: ink.color, boxShadow: ink.boxShadow }}
            >
              <span>Label</span>
              <span className="mono">{hex}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);

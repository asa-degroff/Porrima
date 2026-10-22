import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles/glass.css";
import { OklchColorPicker, inkForSwatch } from "../src/components/OklchColorPicker";

// Luminances chosen to straddle the ink crossover (swatch luminance ≈ 0.183)
// so the flip is visible at the point where white ink and dark ink are equally
// legible — the worst case for the whole rule.
const INK_LADDER = ["#0b0c10", "#1e1b4b", "#3f3f46", "#6b6b6b", "#808080", "#8d8d8d", "#a8a29e", "#fbbf24", "#f8fafc"];

function Harness() {
  const [background, setBackground] = useState("#1e1b4b");
  const [accent, setAccent] = useState("#fbbf24");
  return (
    <div className="wrap">
      <div className="swatch" style={{ background, color: "#fff" }}>
        Live preview — background <span className="mono">{background}</span> · accent{" "}
        <span className="mono">{accent}</span>
      </div>
      <OklchColorPicker label="Background" value={background} onChange={setBackground} darkOnly />
      <OklchColorPicker label="Accent" value={accent} onChange={setAccent} />
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

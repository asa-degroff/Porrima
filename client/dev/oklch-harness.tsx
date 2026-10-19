import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles/glass.css";
import { OklchColorPicker } from "../src/components/OklchColorPicker";

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
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);

import { describe, expect, it } from "vitest";
import { formatArtifactGuidanceWarnings, getArtifactGuidanceWarnings } from "./artifact-guidance.js";

describe("artifact guidance warnings", () => {
  it("warns for p5 global mode with top-level lexical state and shadowed APIs", () => {
    const html = `
      <script src="https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.0/p5.min.js"></script>
      <script>
        const bg = color(8, 8, 15);
        let internalW = 1200;
        function setup() {
          createCanvas(internalW, internalW);
        }
        function mouseMoved() {
          const scaleX = internalW / width;
        }
        function randomSeed() {
          setSeed(floor(random(1, 10000)));
        }
      </script>
    `;

    const warnings = getArtifactGuidanceWarnings(html);

    expect(warnings.some((warning) => warning.includes("p5 global-mode callbacks detected"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("top-level let/const state"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("shadow p5 API names"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("p5 API calls appear before setup"))).toBe(true);
  });

  it("does not warn for p5 instance mode with state inside the sketch closure", () => {
    const html = `
      <script src="https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.0/p5.min.js"></script>
      <div id="sketch"></div>
      <script>
        new p5((p) => {
          const canvasSize = 1200;
          let bg = p.color(8, 8, 15);

          p.setup = () => {
            const canvas = p.createCanvas(canvasSize, canvasSize);
            canvas.parent("sketch");
            p.randomSeed(1);
          };

          p.draw = () => {
            p.background(bg);
          };
        });
      </script>
    `;

    expect(getArtifactGuidanceWarnings(html)).toEqual([]);
  });

  it("formats warnings for tool result feedback", () => {
    expect(formatArtifactGuidanceWarnings([])).toBe("");
    expect(formatArtifactGuidanceWarnings(["first", "second"])).toBe(
      "\n\nHTML artifact guidance warnings:\n- first\n- second"
    );
  });
});

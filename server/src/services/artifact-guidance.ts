export const P5_INSTANCE_MODE_GUIDANCE =
  "For p5.js sketches, prefer instance mode: create new p5((p) => { ... }, container); keep sketch state inside the instance closure; define p.setup, p.draw, and pointer/resize handlers on p; call p5 APIs through p, such as p.createCanvas, p.color, p.randomSeed, and p.noiseSeed; avoid global p5 callbacks and helper names that shadow p5 APIs such as randomSeed, noiseSeed, color, setup, or draw.";

const P5_GLOBAL_CALLBACKS = [
  "setup",
  "draw",
  "preload",
  "mouseMoved",
  "mouseDragged",
  "mousePressed",
  "mouseReleased",
  "mouseClicked",
  "touchStarted",
  "touchMoved",
  "touchEnded",
  "keyPressed",
  "keyReleased",
  "keyTyped",
  "windowResized",
];

const P5_API_NAMES = [
  "color",
  "createCanvas",
  "createGraphics",
  "resizeCanvas",
  "random",
  "randomSeed",
  "noise",
  "noiseSeed",
  "map",
  "lerp",
  "saveCanvas",
];

function hasP5(html: string): boolean {
  return /p5(?:\.min)?\.js/i.test(html) || /\bnew\s+p5\s*\(/.test(html) || /\bp5\./.test(html);
}

function findDeclaredFunctions(html: string, names: string[]): string[] {
  return names.filter((name) => new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(html));
}

function hasTopLevelLexicalState(html: string): boolean {
  return /<script\b[^>]*>[\s\S]*?\b(?:let|const)\s+[A-Za-z_$][\w$]*/i.test(html);
}

function hasP5CallsBeforeSetup(html: string): boolean {
  const setupIndex = html.search(/\bfunction\s+setup\s*\(|\bp\.setup\s*=/);
  if (setupIndex < 0) return false;
  const beforeSetup = html.slice(0, setupIndex);
  return /(?:^|[^\w$.])(?:color|createVector|createCanvas|createGraphics|random|noise)\s*\(/.test(beforeSetup);
}

export function getArtifactGuidanceWarnings(html: unknown): string[] {
  if (typeof html !== "string" || !hasP5(html)) return [];

  const warnings: string[] = [];
  const globalCallbacks = findDeclaredFunctions(html, P5_GLOBAL_CALLBACKS);
  const shadowedApis = findDeclaredFunctions(html, P5_API_NAMES);

  if (globalCallbacks.length > 0) {
    warnings.push(
      `p5 global-mode callbacks detected (${globalCallbacks.join(", ")}). Prefer instance mode with p.setup/p.draw/p.mouseMoved and sketch state inside the new p5 closure.`
    );
  }

  if (globalCallbacks.length > 0 && hasTopLevelLexicalState(html)) {
    warnings.push(
      "p5 global-mode callbacks are combined with top-level let/const state. This can cause temporal-dead-zone runtime errors if p5 invokes a callback while the script is still initializing."
    );
  }

  if (shadowedApis.length > 0) {
    warnings.push(
      `Functions shadow p5 API names (${shadowedApis.join(", ")}). Rename local helpers and call p5 APIs through the instance object, for example p.randomSeed(...).`
    );
  }

  if (hasP5CallsBeforeSetup(html)) {
    warnings.push(
      "p5 API calls appear before setup initialization. In instance mode, initialize colors, vectors, buffers, and seeded randomness inside p.setup or inside the new p5 closure after the p object exists."
    );
  }

  return warnings;
}

export function formatArtifactGuidanceWarnings(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return `\n\nHTML artifact guidance warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
}

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildSkillChipFragment, createSkillChip } from "./skill-chips";

/** Markup of the shape people actually paste into a composer. The live witness
 *  for the old HTML-string path was headless Chrome: this exact payload became a
 *  live <img> whose onerror fired when a draft was restored. */
const PAYLOAD = '<img src=x onerror="window.__composerPwned = 1">';

function mount(text: string, skills: string[]): HTMLElement {
  const host = document.createElement("div");
  host.setAttribute("contenteditable", "true");
  host.replaceChildren(buildSkillChipFragment(document, text, skills));
  return host;
}

describe("buildSkillChipFragment", () => {
  it("keeps markup as text instead of parsing it into elements", () => {
    const text = `fix ${PAYLOAD} now`;
    const host = mount(text, []);

    expect(host.children).toHaveLength(0);
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("[onerror]")).toBeNull();
    expect(host.textContent).toBe(text);
    expect((window as any).__composerPwned).toBeUndefined();
  });

  it("a token match is bounded by the charset, so markup cannot ride into a chip", () => {
    const text = '/x" onerror="y and <script>alert(1)</script>';
    const host = mount(text, ["x"]);
    const chips = host.querySelectorAll("span[data-skill]");

    // `/x` is the only thing the pattern can match — the quote-bearing remainder
    // stays text. The chip exists, and it carries no markup of its own.
    expect(chips).toHaveLength(1);
    expect(chips[0].getAttribute("data-skill")).toBe("x");
    expect(host.querySelectorAll("script")).toHaveLength(0);
    expect(host.textContent).toBe(text);
  });

  it("turns a recognized skill token into a non-editable chip", () => {
    const host = mount("run /deploy now", ["deploy"]);
    const chip = host.querySelector("span[data-skill]") as HTMLSpanElement | null;

    expect(chip).not.toBeNull();
    expect(chip!.getAttribute("data-skill")).toBe("deploy");
    expect(chip!.getAttribute("contenteditable")).toBe("false");
    expect(chip!.textContent).toBe("/deploy");
    expect(host.textContent).toBe("run /deploy now");
  });

  it("leaves unrecognized tokens as plain text", () => {
    const host = mount("see /notaskill and /deploy", ["deploy"]);

    expect(host.querySelectorAll("span")).toHaveLength(1);
    expect(host.textContent).toBe("see /notaskill and /deploy");
  });

  it("preserves order and full text across several chips", () => {
    const text = "/alpha first /beta middle /gamma end";
    const host = mount(text, ["alpha", "beta", "gamma"]);
    const nodes = Array.from(host.childNodes);

    expect(nodes.map((n) => n.nodeType)).toEqual([1, 3, 1, 3, 1, 3]);
    expect(host.textContent).toBe(text);
  });

  it("keeps adjacent tokens intact and newlines exact", () => {
    const text = "/alpha/beta\nline two\n";
    const host = mount(text, ["alpha", "beta"]);

    expect(host.querySelectorAll("span")).toHaveLength(2);
    expect(host.textContent).toBe(text);
  });

  it("handles empty and whitespace-only text", () => {
    expect(buildSkillChipFragment(document, "", []).childNodes).toHaveLength(0);
    expect(mount("", []).childNodes).toHaveLength(0);
    expect(mount("   ", []).textContent).toBe("   ");
  });

  it("produces the same result on repeated calls (shared pattern is not stateful)", () => {
    const first = mount("run /deploy now", ["deploy"]).innerHTML;
    const second = mount("run /deploy now", ["deploy"]).innerHTML;
    expect(first).toBe(second);
  });
});

describe("createSkillChip", () => {
  it("carries the class and styling the composer CSS depends on", () => {
    const chip = createSkillChip(document, "artifact-preview");
    expect(chip.className).toBe("skill-chip");
    // Property reads rather than cssText string matching: jsdom re-serializes
    // cssText with its own spacing.
    expect(chip.style.borderRadius).toBe("12px");
    expect(chip.style.fontWeight).toBe("500");
    expect(chip.getAttribute("contenteditable")).toBe("false");
    expect(chip.textContent).toBe("/artifact-preview");
  });
});

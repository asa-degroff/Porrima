import { describe, expect, it } from "vitest";
import { rehypeMathGate } from "./rehype-math-gate";

interface H {
  type: string;
  tagName?: string;
  properties?: { className?: string[] };
  value?: string;
  children?: H[];
  position?: { start: { offset: number }; end: { offset: number } };
}

function inlineMath(value: string, start: number, end: number): H {
  return {
    type: "element",
    tagName: "code",
    properties: { className: ["language-math", "math-inline"] },
    position: { start: { offset: start }, end: { offset: end } },
    children: [{ type: "text", value }],
  };
}

function displayMath(value: string, start: number, end: number): H {
  return {
    type: "element",
    tagName: "pre",
    position: { start: { offset: start }, end: { offset: end } },
    children: [
      {
        type: "element",
        tagName: "code",
        properties: { className: ["language-math", "math-display"] },
        children: [{ type: "text", value }],
      },
    ],
  };
}

describe("rehypeMathGate", () => {
  it("replaces a span KaTeX cannot parse with the original source span", () => {
    const source = "x $\\bar$ y";
    const tree: H = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          children: [
            { type: "text", value: "x " },
            inlineMath("\\bar", 2, 8),
            { type: "text", value: " y" },
          ],
        },
      ],
    };
    rehypeMathGate(source)()(tree);
    expect(tree.children![0].children![1]).toEqual({ type: "text", value: "$\\bar$" });
  });

  it("keeps a span that parses and passes the content gate", () => {
    const source = "a $x^2$ b";
    const tree: H = {
      type: "root",
      children: [{ type: "element", tagName: "p", children: [inlineMath("x^2", 2, 8)] }],
    };
    rehypeMathGate(source)()(tree);
    expect(tree.children![0].children![0].type).toBe("element");
  });

  it("replaces a parseable-but-gate-failing span with literal text", () => {
    const source = "set $VAR=$PATH";
    const tree: H = {
      type: "root",
      children: [{ type: "element", tagName: "p", children: [inlineMath("VAR=", 4, 10)] }],
    };
    rehypeMathGate(source)()(tree);
    expect(tree.children![0].children![0]).toEqual({ type: "text", value: "$VAR=$" });
  });

  it("replaces a failing display span with its fence span", () => {
    const source = "$$\n\\frac{1}\n$$";
    const tree: H = { type: "root", children: [displayMath("\\frac{1}", 0, 14)] };
    rehypeMathGate(source)()(tree);
    expect(tree.children![0]).toEqual({ type: "text", value: "$$\n\\frac{1}\n$$" });
  });
});

import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import { escapeNonMathDollars } from "./math-delimiters";
import { rehypeMathGate } from "./rehype-math-gate";

interface H {
  type: string;
  tagName?: string;
  properties?: { className?: string[] };
  value?: string;
  children?: H[];
}

function pipeline(source: string): H {
  const prepared = escapeNonMathDollars(source);
  const runner = unified().use(remarkParse).use(remarkMath).use(remarkRehype);
  const tree = runner.runSync(runner.parse(prepared)) as unknown as H;
  rehypeMathGate(prepared)()(tree);
  return tree;
}

function collect(node: H, acc: H[]): void {
  acc.push(node);
  if (node.children) {
    node.children.forEach((c) => collect(c, acc));
  }
}

function textOf(node: H): string {
  if (node.type === "text") {
    return node.value || "";
  }
  return (node.children || []).map(textOf).join("");
}

function mathElements(tree: H, cls: string): H[] {
  const all: H[] = [];
  collect(tree, all);
  return all.filter(
    (n) =>
      n.type === "element" &&
      n.tagName === "code" &&
      Array.isArray(n.properties?.className) &&
      n.properties!.className!.includes(cls)
  );
}

describe("math pipeline (pre-pass + gate) end to end", () => {
  it("registers through unified.use() without crashing (attacher protocol)", () => {
    // Regression: rehypeMathGate must return an attacher, not a bare
    // transformer. A transformer handed to use() is invoked during freeze
    // with no tree and throws on undefined.children.
    const prepared = escapeNonMathDollars("prose $5 and $10, math $x^2$");
    const runner = unified()
      .use(remarkParse)
      .use(remarkMath)
      .use(remarkRehype)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .use(rehypeMathGate(prepared) as any);
    const tree = runner.runSync(runner.parse(prepared)) as unknown as H;
    const m = mathElements(tree, "math-inline");
    expect(m.length).toBe(1);
    expect(textOf(m[0])).toBe("x^2");
    expect(textOf(tree)).toContain("$5 and $10");
  });

  it("renders prose dollars literally", () => {
    for (const input of [
      "set $VAR=$PATH now",
      "we have $5 and $10 in the budget",
      "typed $$ for $$$ (doc bullet)",
      "cost is $5\nand $10 total",
    ]) {
      const tree = pipeline(input);
      expect(mathElements(tree, "math-inline")).toEqual([]);
      expect(textOf(tree)).toBe(input);
    }
  });

  it("keeps valid math as math elements", () => {
    const t1 = pipeline("A_mean is $A_mean$ exactly");
    const m1 = mathElements(t1, "math-inline");
    expect(m1.length).toBe(1);
    expect(textOf(m1[0])).toBe("A_mean");
    const t2 = pipeline("$$\nx^2\n$$");
    const m2 = mathElements(t2, "math-display");
    expect(m2.length).toBe(1);
    expect(textOf(m2[0])).toBe("x^2");
  });

  it("demotes gate-passing but unparseable math to literal text", () => {
    const tree = pipeline("broken $a{b$ span");
    expect(mathElements(tree, "math-inline")).toEqual([]);
    expect(textOf(tree)).toBe("broken $a{b$ span");
  });

  it("leaves code spans byte-identical", () => {
    const tree = pipeline("`$x$` and $$$NAME$$` done");
    const all: H[] = [];
    collect(tree, all);
    const codes = all.filter((n) => n.type === "element" && n.tagName === "code");
    expect(codes.length).toBe(1);
    expect(textOf(codes[0])).toBe("$x$");
  });
});

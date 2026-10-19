import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import { escapeNonMathDollars, looksLikeMath } from "./math-delimiters";

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

function mathValues(md: string): string[] {
  const runner = unified().use(remarkParse).use(remarkMath);
  const tree = runner.runSync(runner.parse(md)) as unknown as MdNode;
  const values: string[] = [];
  const walk = (node: MdNode): void => {
    if (node.type === "inlineMath" || node.type === "math") {
      values.push(node.value || "");
    }
    if (node.children) {
      node.children.forEach(walk);
    }
  };
  walk(tree);
  return values;
}

const LITERAL_INPUTS = [
  "typed $$ for $$$ (doc bullet)",
  "we have $5 and $10 in the budget",
  "binding $$$NAME in a pattern",
  "set $VAR=$PATH now",
  "cost is $5\nand $10 total",
  "$ a $ with padding",
  "a $5+$10 b",
];

describe("escapeNonMathDollars", () => {
  it("escapes non-delimiter dollar runs (field regression suite)", () => {
    const cases: Array<[string, string]> = [
      ["typed $$ for $$$ (doc bullet)", "typed \\$\\$ for \\$\\$\\$ (doc bullet)"],
      ["we have $5 and $10 in the budget", "we have \\$5 and \\$10 in the budget"],
      ["binding $$$NAME in a pattern", "binding \\$\\$\\$NAME in a pattern"],
      ["set $VAR=$PATH now", "set \\$VAR=\\$PATH now"],
      ["cost is $5\nand $10 total", "cost is \\$5\nand \\$10 total"],
      ["$ a $ with padding", "\\$ a \\$ with padding"],
      ["a $5+$10 b", "a \\$5+\\$10 b"],
      ["escaped \\$5 literal", "escaped \\$5 literal"],
      ["unclosed fence: $$\nstill here", "unclosed fence: \\$\\$\nstill here"],
      ["smaller close: $$$\nx\n$$", "smaller close: \\$\\$\\$\nx\n\\$\\$"],
    ];
    for (const [input, expected] of cases) {
      expect(escapeNonMathDollars(input)).toBe(expected);
    }
  });

  it("leaves valid inline math untouched", () => {
    const cases: Array<[string, string]> = [
      ["A_mean is $A_mean$ exactly", "A_mean is $A_mean$ exactly"],
      ["keep $n_max=3$ here", "keep $n_max=3$ here"],
      ["tau is $\\tau$ here", "tau is $\\tau$ here"],
      ["so $n=3$ now", "so $n=3$ now"],
      ["double run $$x^2$$ inline", "double run $$x^2$$ inline"],
    ];
    for (const [input, expected] of cases) {
      expect(escapeNonMathDollars(input)).toBe(expected);
    }
  });

  it("leaves code regions untouched", () => {
    const cases: string[] = [
      "`$x$` in a code span",
      "a `b$ c$d` e",
      "see [x](https://e.com/$a$)",
      "```\ncost = $5 + $10\n```",
      "text\n    x = $5 + $10\nmore",
      "\tcode = $1 + $2",
    ];
    for (const input of cases) {
      expect(escapeNonMathDollars(input)).toBe(input);
    }
  });

  it("leaves display fences untouched", () => {
    const cases: string[] = [
      "$$\nx^2\n$$",
      "$$\nx\n$$$",
      "$$latex\nE=mc^2\n$$",
      "$$$\nA = B\n$$$",
    ];
    for (const input of cases) {
      expect(escapeNonMathDollars(input)).toBe(input);
    }
  });

  it("produces no math spans where none are valid", () => {
    for (const input of LITERAL_INPUTS) {
      expect(mathValues(escapeNonMathDollars(input))).toEqual([]);
    }
  });

  it("produces exactly the intended math spans", () => {
    expect(mathValues(escapeNonMathDollars("A_mean is $A_mean$ exactly"))).toEqual(["A_mean"]);
    expect(mathValues(escapeNonMathDollars("keep $n_max=3$ here"))).toEqual(["n_max=3"]);
    expect(mathValues(escapeNonMathDollars("tau is $\\tau$ here"))).toEqual(["\\tau"]);
    expect(mathValues(escapeNonMathDollars("so $n=3$ now"))).toEqual(["n=3"]);
    expect(mathValues(escapeNonMathDollars("$$\nx^2\n$$"))).toEqual(["x^2"]);
  });

  it("is idempotent", () => {
    const inputs = [
      ...LITERAL_INPUTS,
      "A_mean is $A_mean$ exactly",
      "$$\nx^2\n$$",
      "a `b$ c$d` e",
      "escaped \\$5 literal",
      "unclosed: $$\nstill here",
    ];
    for (const input of inputs) {
      const once = escapeNonMathDollars(input);
      expect(escapeNonMathDollars(once)).toBe(once);
    }
  });
});

describe("looksLikeMath", () => {
  it("accepts math-marked content", () => {
    expect(looksLikeMath("A_mean")).toBe(true);
    expect(looksLikeMath("x^2")).toBe(true);
    expect(looksLikeMath("\\tau")).toBe(true);
    expect(looksLikeMath("{1}")).toBe(true);
    expect(looksLikeMath("n=3")).toBe(true);
  });

  it("rejects non-math content", () => {
    expect(looksLikeMath("")).toBe(false);
    expect(looksLikeMath("VAR=")).toBe(false);
    expect(looksLikeMath("for")).toBe(false);
    expect(looksLikeMath("5+")).toBe(false);
    expect(looksLikeMath("0.5992")).toBe(false);
    expect(looksLikeMath("5 and ")).toBe(false);
  });
});

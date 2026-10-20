import katex from "katex";
import { looksLikeMath } from "./math-delimiters";

interface HNode {
  type: string;
  tagName?: string;
  properties?: { className?: string[] };
  value?: string;
  children?: HNode[];
  position?: { start: { offset: number }; end: { offset: number } };
}

function hasClass(cls: string[] | undefined, target: string): boolean {
  return Array.isArray(cls) && cls.includes(target);
}

function katexParses(value: string, displayMode: boolean): boolean {
  try {
    katex.renderToString(value, { throwOnError: true, strict: "ignore", displayMode });
    return true;
  } catch {
    return false;
  }
}

function spanText(source: string, anchor: HNode, value: string): string {
  const pos = anchor.position;
  if (pos && pos.start.offset >= 0 && pos.end.offset <= source.length) {
    return source.slice(pos.start.offset, pos.end.offset);
  }
  return "$" + value + "$";
}

function mathValue(children: HNode[]): string {
  return children
    .filter((c) => c.type === "text")
    .map((c) => c.value || "")
    .join("");
}

/**
 * Rehype plugin that runs before rehype-katex. Replaces math nodes whose
 * content fails the content gate or that KaTeX cannot parse with the original
 * source span as literal text - the text as written. View-only: it never
 * touches persisted content.
 *
 * `source` must be the exact string that was parsed (the output of
 * escapeNonMathDollars); the original span is recovered from the node's
 * position offsets (for display math, from its `pre` wrapper).
 *
 * Returns a unified **attacher** (a zero-argument function yielding the
 * transformer), which is what `use()` expects for a plugin. Handing the raw
 * transformer to `use()` instead makes unified call it during freeze with no
 * tree, crashing on `undefined.children`.
 */
export function rehypeMathGate(source: string) {
  return () => (tree: HNode): void => {
    walk(tree);
  };

  function walk(node: HNode): void {
    const children = node.children;
    if (!children) {
      return;
    }
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.type !== "element" || !child.children) {
        continue;
      }
      if (child.tagName === "pre") {
        // Display math: the `pre` wrapper carries the fence span position.
        const inner = child.children[0];
        if (
          inner &&
          inner.type === "element" &&
          inner.tagName === "code" &&
          inner.children &&
          hasClass(inner.properties && inner.properties.className, "math-display")
        ) {
          const value = mathValue(inner.children);
          if (!(looksLikeMath(value) && katexParses(value, true))) {
            children[i] = { type: "text", value: spanText(source, child, value) };
            continue;
          }
        }
      } else if (child.tagName === "code") {
        const cls = child.properties && child.properties.className;
        if (hasClass(cls, "math-inline")) {
          const value = mathValue(child.children);
          if (!(looksLikeMath(value) && katexParses(value, false))) {
            children[i] = { type: "text", value: spanText(source, child, value) };
            continue;
          }
        }
      }
      walk(child);
    }
  }
}

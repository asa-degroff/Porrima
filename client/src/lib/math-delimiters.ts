/**
 * View-only math-delimiter preparation for the markdown render path.
 *
 * remark-math tokenizes `$` runs with no whitespace-adjacency rules, so prose
 * like "$5 and $10" or "set $VAR=$PATH" can open math spans. This pass runs on
 * a render copy of the source (never on persisted text) and escapes `$` runs
 * that are not valid math delimiters, leaving only spans that satisfy:
 *
 * - the opening `$` run is immediately followed by a non-whitespace character
 * - the closing `$` run is the next `$` run, of exactly the same length, and
 *   is immediately preceded by a non-whitespace character
 * - the content is non-empty and contains no line ending
 * - inline content passes `looksLikeMath`
 *
 * `$$` display fences on their own line are left untouched, as are fenced
 * code, indented code lines, inline code spans, and link destinations - the
 * micromark tokenizer already protects those regions, and escaping there
 * would only corrupt the rendered text.
 */

const WS = " \t\r\n";

function isSpaceOrNewline(ch: string | undefined): boolean {
  return ch !== undefined && WS.includes(ch);
}

function backslashCountBefore(src: string, i: number): number {
  let count = 0;
  let j = i - 1;
  while (j >= 0 && src[j] === "\\") {
    count++;
    j--;
  }
  return count;
}

/**
 * Content gate for math spans. Deliberately conservative: it kills the
 * parse-but-wrong class (VAR=, for, bare numerals) that KaTeX happily
 * renders. The parse-success gate (rehype-math-gate) backstops syntax.
 */
export function looksLikeMath(content: string): boolean {
  const c = content.trim();
  if (c.length === 0) {
    return false;
  }
  if (c.includes("\\")) {
    return true;
  }
  if (c.includes("{") || c.includes("}")) {
    return true;
  }
  if (c.includes("_") || c.includes("^")) {
    return true;
  }
  return /\d/.test(c) && /[a-zA-Z]/.test(c) && /[+\-*/=<>~]/.test(c);
}

interface LineInfo {
  start: number;
  end: number;
  text: string;
}

/**
 * Mark character offsets inside protected regions (fenced code, indented code
 * lines). The pre-pass never mutates these: escaping a `$` there would show
 * the backslash in the rendered output.
 */
function protectedChars(src: string): Uint8Array {
  const prot = new Uint8Array(src.length);
  const lines: LineInfo[] = [];
  let lineStart = 0;
  for (let i = 0; i <= src.length; i++) {
    if (i === src.length || src[i] === "\n") {
      lines.push({ start: lineStart, end: i, text: src.slice(lineStart, i).replace(/\r$/, "") });
      lineStart = i + 1;
    }
  }

  const mark = (li: number): void => {
    for (let c = lines[li].start; c < lines[li].end; c++) {
      prot[c] = 1;
    }
  };

  // Fenced code blocks (backtick or tilde fences, up to 3 leading spaces).
  const inFence: boolean[] = new Array(lines.length).fill(false);
  for (let li = 0; li < lines.length; li++) {
    if (inFence[li]) {
      continue;
    }
    const m = lines[li].text.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!m) {
      continue;
    }
    const closeRe = new RegExp(`^ {0,3}${m[1][0]}{${m[1].length},}[ \t]*$`);
    let close = -1;
    for (let lj = li + 1; lj < lines.length; lj++) {
      if (closeRe.test(lines[lj].text)) {
        close = lj;
        break;
      }
    }
    const last = close === -1 ? lines.length - 1 : close;
    for (let lj = li; lj <= last; lj++) {
      inFence[lj] = true;
    }
  }

  // Indented code lines (leading tab or 4+ spaces), consecutive runs.
  const isIndented = (t: string): boolean => /^\t/.test(t) || /^ {4,}/.test(t);
  let i = 0;
  while (i < lines.length) {
    if (!inFence[i] && isIndented(lines[i].text)) {
      let j = i;
      while (j < lines.length && !inFence[j] && isIndented(lines[j].text)) {
        j++;
      }
      for (let lj = i; lj < j; lj++) {
        mark(lj);
      }
      i = j;
    } else {
      i++;
    }
  }
  for (let lj = 0; lj < lines.length; lj++) {
    if (inFence[lj]) {
      mark(lj);
    }
  }
  return prot;
}

function isLineStartAt(src: string, i: number): boolean {
  let spaces = 0;
  let j = i - 1;
  while (j >= 0 && src[j] === " ") {
    spaces++;
    j--;
    if (spaces > 3) {
      return false;
    }
  }
  return j === -1 || src[j] === "\n";
}

/**
 * Find the closing line of a display fence whose opening `$` run has length
 * `k`. The opening line ends at `openEol` (-1 at end of input). Returns the
 * offset just past the closing line (including its line ending), or null.
 */
function findClosingFence(src: string, openEol: number, k: number): number | null {
  const re = new RegExp(`^ {0,3}${"\\$".repeat(k)}\\$*[ \t]*$`);
  let pos = openEol === -1 ? src.length : openEol + 1;
  const n = src.length;
  while (pos < n) {
    const eol = src.indexOf("\n", pos);
    const end = eol === -1 ? n : eol;
    if (re.test(src.slice(pos, end))) {
      return eol === -1 ? n : eol + 1;
    }
    pos = eol === -1 ? n : eol + 1;
  }
  return null;
}

/**
 * From `start` (just past the opening `$` run of length `k`), find a valid
 * inline closing run. Returns the offset just past the closing run, or null.
 */
function findInlineSpan(src: string, prot: Uint8Array, start: number, k: number): number | null {
  let j = start;
  while (j < src.length) {
    if (prot[j] === 1) {
      return null;
    }
    if (src[j] === "$") {
      break;
    }
    j++;
  }
  if (j >= src.length) {
    return null;
  }
  let k2 = 0;
  while (j + k2 < src.length && src[j + k2] === "$") {
    k2++;
  }
  if (k2 !== k) {
    return null;
  }
  const prevCh = j > 0 ? src[j - 1] : undefined;
  if (isSpaceOrNewline(prevCh)) {
    return null;
  }
  const content = src.slice(start, j);
  if (content.length === 0 || content.includes("\n") || content.includes("\r")) {
    return null;
  }
  if (!looksLikeMath(content)) {
    return null;
  }
  return j + k2;
}

/**
 * For a link destination starting just after `](`, return the offset just
 * past the closing `)` (or `>`, or end of input).
 */
function destinationEnd(src: string, start: number): number {
  let j = start;
  while (j < src.length && (src[j] === " " || src[j] === "\t")) {
    j++;
  }
  if (j < src.length && src[j] === "<") {
    const close = src.indexOf(">", j + 1);
    return close === -1 ? src.length : close + 1;
  }
  let depth = 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) {
        return j + 1;
      }
    }
    j++;
  }
  return src.length;
}

/**
 * Return a render copy of `src` where every `$` run that is not a valid math
 * delimiter is escaped (`\$`) so the micromark math tokenizer cannot open a
 * span on it. Valid spans, display fences, and code regions pass through
 * untouched. Idempotent.
 */
export function escapeNonMathDollars(src: string): string {
  const prot = protectedChars(src);
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (prot[i] === 1) {
      out.push(ch);
      i++;
      continue;
    }
    if (ch === "`") {
      // Inline code span: copy through untouched.
      let runLen = 0;
      while (i + runLen < n && src[i + runLen] === "`") {
        runLen++;
      }
      let j = i + runLen;
      let spanEnd = -1;
      while (j < n) {
        if (src[j] === "`") {
          let r2 = 0;
          while (j + r2 < n && src[j + r2] === "`") {
            r2++;
          }
          if (r2 === runLen) {
            spanEnd = j + r2;
            break;
          }
          j += r2;
        } else {
          j++;
        }
      }
      if (spanEnd === -1) {
        out.push(src.slice(i, i + runLen));
        i += runLen;
      } else {
        out.push(src.slice(i, spanEnd));
        i = spanEnd;
      }
      continue;
    }
    if (ch === "]" && src[i + 1] === "(") {
      // Link destination: copy through untouched.
      const end = destinationEnd(src, i + 2);
      out.push(src.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "$") {
      if (backslashCountBefore(src, i) % 2 === 1) {
        // Author-escaped dollar: already literal, leave it.
        out.push(ch);
        i++;
        continue;
      }
      let k = 0;
      while (i + k < n && src[i + k] === "$") {
        k++;
      }
      const runEnd = i + k;
      const nextCh = src[runEnd];
      // Display fence candidate: `$` run of 2+ at line start, no other `$`
      // on the line.
      if (k >= 2 && isLineStartAt(src, i)) {
        const eol = src.indexOf("\n", i);
        const lineRest = eol === -1 ? src.slice(runEnd) : src.slice(runEnd, eol);
        if (!lineRest.includes("$")) {
          const close = findClosingFence(src, eol, k);
          if (close !== null) {
            out.push(src.slice(i, close));
            i = close;
            continue;
          }
        }
      }
      // Inline opener candidate.
      if (nextCh !== undefined && !isSpaceOrNewline(nextCh)) {
        const spanEnd = findInlineSpan(src, prot, runEnd, k);
        if (spanEnd !== null) {
          out.push(src.slice(i, spanEnd));
          i = spanEnd;
          continue;
        }
      }
      // Not part of a valid span: escape every dollar in the run.
      for (let c = 0; c < k; c++) {
        out.push("\\$");
      }
      i = runEnd;
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

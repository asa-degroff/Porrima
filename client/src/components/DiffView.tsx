interface DiffLine {
  type: "context" | "add" | "remove";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

function computeLineDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  // LCS table
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack with line number tracking
  const result: DiffLine[] = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ 
        type: "context", 
        content: oldLines[i - 1],
        oldLineNumber: i,
        newLineNumber: j
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ 
        type: "add", 
        content: newLines[j - 1],
        newLineNumber: j
      });
      j--;
    } else {
      result.unshift({ 
        type: "remove", 
        content: oldLines[i - 1],
        oldLineNumber: i
      });
      i--;
    }
  }

  return result;
}

const lineStyles = {
  context: "text-white/30",
  remove: "text-red-300/70 bg-red-500/10",
  add: "text-emerald-300/70 bg-emerald-500/10",
};

const prefixes = { context: " ", remove: "\u2212", add: "+" };

interface Props {
  oldString: string;
  newString: string;
}

export function DiffView({ oldString, newString }: Props) {
  const lines = computeLineDiff(oldString, newString);

  return (
    <div className="font-mono text-xs leading-relaxed">
      {lines.map((line, i) => (
        <div key={i} className={`${lineStyles[line.type]} whitespace-pre-wrap break-all flex`}>
          <span className="inline-block w-4 text-center select-none opacity-60">
            {prefixes[line.type]}
          </span>
          {line.type !== "add" && (
            <span className="inline-block w-8 text-right select-none opacity-60 mr-2">
              {line.oldLineNumber ?? ""}
            </span>
          )}
          {line.type !== "remove" && (
            <span className="inline-block w-8 text-right select-none opacity-60 mr-2">
              {line.newLineNumber ?? ""}
            </span>
          )}
          {line.content}
        </div>
      ))}
    </div>
  );
}

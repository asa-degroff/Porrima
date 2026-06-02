import { readFile } from "fs/promises";
import { getTokenEstimateLogPath } from "../services/token-estimate-observability.js";

interface ToolResultSample {
  sampleType: "tool_result_exact";
  toolName?: string;
  heuristicBranch?: string;
  heuristicCharsPerToken?: number;
  heuristicTokens?: number;
  exactTokens?: number;
  ratioEstimateToExact?: number;
  exactCharsPerToken?: number;
  contentChars?: number;
  deltaTokens?: number;
}

interface ContextSample {
  sampleType: "context_estimate_observed";
  ratioEstimateToObserved?: number;
  ratioDisplayEstimateToObserved?: number;
  estimatedInputTokens?: number;
  displayEstimatedInputTokens?: number;
  approximateDisplayTokens?: number;
  selectedEstimatePath?: "usage_anchor" | "char_estimate";
  displayEstimatePath?: "usage_anchor" | "char_estimate";
  pathAEstimateTokens?: number;
  pathBEstimateTokens?: number;
  lastUsageInputTokens?: number;
  lastUsageOutputTokens?: number;
  lastUsageTotalTokens?: number;
  postUsageAdditionalTokens?: number;
  observedInputTokens?: number;
  exactToolResultCount?: number;
  signedExactDelta?: number;
}

type Sample = ToolResultSample | ContextSample;

function percentile(values: number[], p: number): number | undefined {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function mean(values: number[]): number | undefined {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return undefined;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function formatNumber(value: number | undefined, digits = 2): string {
  return value === undefined || !Number.isFinite(value) ? "n/a" : value.toFixed(digits);
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function summarizeRatios(label: string, ratios: number[]): void {
  console.log(
    `${label}: count=${ratios.length} mean=${formatNumber(mean(ratios))} ` +
    `p50=${formatNumber(percentile(ratios, 0.50))} p75=${formatNumber(percentile(ratios, 0.75))} ` +
    `p90=${formatNumber(percentile(ratios, 0.90))}`,
  );
}

async function main() {
  const path = process.argv[2] || getTokenEstimateLogPath();
  const text = await readFile(path, "utf8").catch((err) => {
    throw new Error(`Failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  });

  const samples: Sample[] = [];
  for (const [idx, line] of text.split(/\n/).entries()) {
    if (!line.trim()) continue;
    try {
      samples.push(JSON.parse(line) as Sample);
    } catch (err) {
      console.warn(`Skipping malformed JSONL line ${idx + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const toolSamples = samples.filter((sample): sample is ToolResultSample => sample.sampleType === "tool_result_exact");
  const contextSamples = samples.filter((sample): sample is ContextSample => sample.sampleType === "context_estimate_observed");

  console.log(`Read ${samples.length} sample(s) from ${path}`);
  console.log("");

  if (toolSamples.length) {
    console.log("Tool result exact-count samples");
    const byBranch = groupBy(toolSamples, (sample) => sample.heuristicBranch || "unknown");
    for (const [branch, group] of [...byBranch.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const ratios = group.map((sample) => sample.ratioEstimateToExact).filter((v): v is number => typeof v === "number");
      const exactCpt = group.map((sample) => sample.exactCharsPerToken).filter((v): v is number => typeof v === "number");
      const currentCpt = percentile(
        group.map((sample) => sample.heuristicCharsPerToken).filter((v): v is number => typeof v === "number"),
        0.50,
      );
      const suggestedCpt = percentile(exactCpt, 0.10);
      const meanDelta = mean(group.map((sample) => sample.deltaTokens ?? 0));
      console.log(
        `- ${branch}: count=${group.length} currentCPT=${formatNumber(currentCpt)} ` +
        `exactCPT_p10=${formatNumber(suggestedCpt)} exactCPT_p50=${formatNumber(percentile(exactCpt, 0.50))} ` +
        `est/exact_mean=${formatNumber(mean(ratios))} est/exact_p90=${formatNumber(percentile(ratios, 0.90))} ` +
        `meanDelta=${formatNumber(meanDelta, 0)}`,
      );
    }

    console.log("");
    console.log("Tool result samples by tool");
    const byTool = groupBy(toolSamples, (sample) => sample.toolName || "unknown");
    for (const [toolName, group] of [...byTool.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
      const ratios = group.map((sample) => sample.ratioEstimateToExact).filter((v): v is number => typeof v === "number");
      console.log(`- ${toolName}: count=${group.length} est/exact_mean=${formatNumber(mean(ratios))} p90=${formatNumber(percentile(ratios, 0.90))}`);
    }
  } else {
    console.log("No tool result exact-count samples.");
  }

  console.log("");

  if (contextSamples.length) {
    console.log("Context estimate observations");
    const conservativeRatios = contextSamples
      .map((sample) => sample.ratioEstimateToObserved)
      .filter((v): v is number => typeof v === "number");
    summarizeRatios("conservative estimate / observed input", conservativeRatios);
    summarizeRatios(
      "display estimate / observed input",
      contextSamples.map((sample) => sample.ratioDisplayEstimateToObserved).filter((v): v is number => typeof v === "number"),
    );

    console.log("");
    console.log("Context estimate paths");
    const byPath = groupBy(contextSamples, (sample) => sample.selectedEstimatePath || "unknown");
    for (const [pathName, group] of [...byPath.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const ratios = group
        .map((sample) => sample.ratioEstimateToObserved)
        .filter((v): v is number => typeof v === "number");
      console.log(
        `- ${pathName}: count=${group.length} mean=${formatNumber(mean(ratios))} ` +
        `p50=${formatNumber(percentile(ratios, 0.50))} p90=${formatNumber(percentile(ratios, 0.90))}`,
      );
    }

    console.log("");
    console.log("Context display paths");
    const byDisplayPath = groupBy(contextSamples, (sample) => sample.displayEstimatePath || "unknown");
    for (const [pathName, group] of [...byDisplayPath.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const ratios = group
        .map((sample) => sample.ratioDisplayEstimateToObserved)
        .filter((v): v is number => typeof v === "number");
      console.log(
        `- ${pathName}: count=${group.length} mean=${formatNumber(mean(ratios))} ` +
        `p50=${formatNumber(percentile(ratios, 0.50))} p90=${formatNumber(percentile(ratios, 0.90))}`,
      );
    }

    const pathARatios = contextSamples
      .map((sample) => sample.pathAEstimateTokens && sample.observedInputTokens
        ? sample.pathAEstimateTokens / sample.observedInputTokens
        : undefined)
      .filter((v): v is number => typeof v === "number");
    const pathBRatios = contextSamples
      .map((sample) => sample.pathBEstimateTokens && sample.observedInputTokens
        ? sample.pathBEstimateTokens / sample.observedInputTokens
        : undefined)
      .filter((v): v is number => typeof v === "number");
    summarizeRatios("path A usage-anchor / observed input", pathARatios);
    summarizeRatios("path B char-estimate / observed input", pathBRatios);
  } else {
    console.log("No context estimate observations.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

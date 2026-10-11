import { describe, expect, it } from "vitest";
import type { Settings } from "../types.js";
import {
  mergeServiceConfig,
  parseManagedServiceConfig,
  renderServiceExecStart,
} from "../services/llama-service-config.js";
import { kvCacheFlagPath } from "../services/paths.js";
import {
  renderExecStart,
  renderRouterExecStart,
} from "../services/llama-launch-templates.js";

const settings = {
  extractionCtxSize: 32768,
  llamaModelsDirs: ["/models"],
  llamaServerBins: {
    extraction: "/bin/llama-server",
    "title-generation": "/bin/llama-server",
  },
} as unknown as Settings;

function extractionConfig() {
  return mergeServiceConfig("extraction", settings, {
    binaryPath: "/bin/llama-server",
    modelPath: "/models/extract.gguf",
    modelId: "extract",
  });
}

describe("llama service config chat templates", () => {
  it("renders --jinja for extraction service configs", () => {
    const execStart = renderServiceExecStart("extraction", extractionConfig());

    expect(execStart).toContain("--chat-template-kwargs");
    expect(execStart).toContain("--jinja");
  });

  it("normalizes old managed extraction overrides missing --jinja", () => {
    const oldOverride = `[Service]
ExecStart=
ExecStart=/bin/llama-server \\
    -m '/models/gemma.gguf' \\
    --port 32101 \\
    --host 127.0.0.1 \\
    --n-gpu-layers 0 \\
    --ctx-size 32768 \\
    --parallel 1 \\
    --reasoning-format deepseek \\
    --chat-template-kwargs '{"enable_thinking":true}'
`;

    const parsed = parseManagedServiceConfig("extraction", oldOverride, extractionConfig());
    const execStart = renderServiceExecStart("extraction", parsed);

    expect(parsed.extraArgs).toContain("--jinja");
    expect(execStart).toContain("--jinja");
  });

  it("renders --jinja in legacy extraction launch templates", () => {
    const single = renderExecStart("extraction", {
      ggufPath: "/models/gemma.gguf",
      modelId: "gemma",
      settings,
    });
    const router = renderRouterExecStart("extraction", settings);

    expect(single).toContain("--jinja");
    expect(router).toContain("--jinja");
  });
});

// KV snapshot parking (docs/design/kv-snapshot-parking.md §6): the inference
// slot's --slot-save-path is render-derived, never stored in extraArgs, and
// must survive the parse->render round-trip exactly once.
describe("kv snapshot parking flag", () => {
  const flagPath = kvCacheFlagPath();

  // ExecStart renders one token per continuation line; fold them (and the
  // resulting double spaces) so quoted flag+value pairs match as text.
  const flat = (execStart: string) =>
    execStart.replace(/\\\s+/g, " ").replace(/ {2,}/g, " ");

  function inferenceConfig() {
    return mergeServiceConfig("inference", settings, {
      binaryPath: "/bin/llama-server",
      mode: "router",
    });
  }

  it("renders --slot-save-path once for the inference slot, trailing separator included", () => {
    const execStart = renderServiceExecStart("inference", inferenceConfig());

    expect(flagPath.endsWith("/")).toBe(true);
    expect(execStart.split("--slot-save-path").length - 1).toBe(1);
    expect(flat(execStart)).toContain(`--slot-save-path '${flagPath}'`);
  });

  it("omits --slot-save-path for helper slots", () => {
    expect(renderServiceExecStart("extraction", extractionConfig())).not.toContain("--slot-save-path");
  });

  it("drops the rendered flag on parse so round-trips never duplicate it", () => {
    const rendered = renderServiceExecStart("inference", inferenceConfig());
    const override = `[Service]\nExecStart=\nExecStart=${rendered}\n`;

    const parsed = parseManagedServiceConfig("inference", override, inferenceConfig());
    const rerendered = renderServiceExecStart("inference", parsed);

    expect(parsed.extraArgs).not.toContain("--slot-save-path");
    expect(rerendered.split("--slot-save-path").length - 1).toBe(1);
    expect(flat(rerendered)).toContain(`--slot-save-path '${flagPath}'`);
  });

  it("canonicalizes a stale manual --slot-save-path to the derived value", () => {
    const manual = `[Service]
ExecStart=
ExecStart=/bin/llama-server \\
    --models-dir '/models' \\
    --port 8080 \\
    --host 127.0.0.1 \\
    --slot-save-path '/somewhere/else/' \\
    --jinja
`;

    const parsed = parseManagedServiceConfig("inference", manual, inferenceConfig());
    const execStart = renderServiceExecStart("inference", parsed);

    expect(parsed.extraArgs).not.toContain("--slot-save-path");
    expect(flat(execStart)).toContain(`--slot-save-path '${flagPath}'`);
    expect(execStart).not.toContain("/somewhere/else/");
  });

  it("preserves a manual --slot-save-path in extraArgs for non-inference slots", () => {
    const manual = `[Service]
ExecStart=
ExecStart=/bin/llama-server \\
    --models-dir '/models' \\
    --port 32101 \\
    --host 127.0.0.1 \\
    --n-gpu-layers 0 \\
    --ctx-size 4096 \\
    --parallel 1 \\
    --slot-save-path '/manual/dir/' \\
    --jinja
`;

    const parsed = parseManagedServiceConfig("extraction", manual, extractionConfig());

    expect(parsed.extraArgs).toContain("--slot-save-path");
    expect(parsed.extraArgs).toContain("/manual/dir/");
  });
});

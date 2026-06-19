import { describe, expect, it } from "vitest";
import type { Settings } from "../types.js";
import {
  mergeServiceConfig,
  parseManagedServiceConfig,
  renderServiceExecStart,
} from "../services/llama-service-config.js";
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

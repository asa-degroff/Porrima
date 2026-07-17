import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalWorkspaceAdapter } from "./workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace Python execution", () => {
  it("runs in the active workspace and leaves files there", async () => {
    const root = await mkdtemp(join(tmpdir(), "porrima-workspace-python-"));
    roots.push(root);
    const workspace = new LocalWorkspaceAdapter(root);

    const result = await workspace.runPython({
      code: "from pathlib import Path\nPath('result.txt').write_text('ok')\nprint(Path.cwd())",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain(root);
    expect(await readFile(join(root, "result.txt"), "utf-8")).toBe("ok");
  });

  it("honors cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "porrima-workspace-python-"));
    roots.push(root);
    const workspace = new LocalWorkspaceAdapter(root);
    const controller = new AbortController();
    controller.abort();

    const result = await workspace.runPython({ code: "print('should not run')" }, controller.signal);

    expect(result).toEqual({ content: "Python execution aborted", isError: true });
  });
});

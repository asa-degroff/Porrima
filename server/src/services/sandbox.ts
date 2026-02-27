import { execFile } from "child_process";
import { writeFile, mkdir, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { v4 as uuid } from "uuid";

const ARTIFACTS_DIR = join(homedir(), ".quje-agent", "artifacts");

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function executePython(
  code: string,
  timeout: number = 30
): Promise<ExecutionResult> {
  const tempFile = join(tmpdir(), `quje-py-${uuid()}.py`);

  try {
    await writeFile(tempFile, code, "utf-8");

    return await new Promise<ExecutionResult>((resolve) => {
      execFile(
        "python3",
        [tempFile],
        {
          timeout: timeout * 1000,
          maxBuffer: 1024 * 1024,
          cwd: tmpdir(),
          env: { ...process.env },
        },
        (error, stdout, stderr) => {
          if (error) {
            if (error.killed) {
              resolve({
                stdout: stdout || "",
                stderr: `Execution timed out after ${timeout}s\n${stderr || ""}`,
                exitCode: 124,
              });
            } else {
              resolve({
                stdout: stdout || "",
                stderr: stderr || error.message,
                exitCode: error.code ? Number(error.code) : 1,
              });
            }
          } else {
            resolve({
              stdout: stdout || "",
              stderr: stderr || "",
              exitCode: 0,
            });
          }
        }
      );
    });
  } finally {
    unlink(tempFile).catch(() => {});
  }
}

export async function createArtifact(
  id: string,
  html: string
): Promise<string> {
  const artifactDir = join(ARTIFACTS_DIR, id);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "index.html"), html, "utf-8");
  return `/api/artifacts/${id}`;
}

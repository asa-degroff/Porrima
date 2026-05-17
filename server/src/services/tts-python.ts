import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TTSBackend } from "../types/tts.js";

type TtsPythonBackend = TTSBackend;

interface PythonCandidate {
  path: string;
  source: string;
}

export interface TtsPythonResolution {
  pythonPath: string;
  source: string;
  requiredImports: string[];
}

export interface TtsPythonStatus {
  available: boolean;
  pythonPath?: string;
  source?: string;
  requiredImports: string[];
  installCommand: string;
  error?: string;
  candidates: Array<{ path: string; source: string; available: boolean; missingImports?: string[]; error?: string }>;
}

const BACKEND_INSTALL_COMMANDS: Record<TtsPythonBackend, string> = {
  kokoro: "./scripts/install-tts-backend.sh kokoro",
  "qwen3-tts": "./scripts/install-tts-backend.sh qwen3-tts",
  "supertonic-3": "./scripts/install-tts-backend.sh supertonic-3",
};

const REQUIRED_IMPORTS: Record<TtsPythonBackend, string[]> = {
  kokoro: ["numpy", "kokoro"],
  "qwen3-tts": ["qwen_tts", "torch", "soundfile"],
  "supertonic-3": ["supertonic", "soundfile", "numpy"],
};

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return null;
  const [key, ...valueParts] = trimmed.split("=");
  const name = key.trim();
  let value = valueParts.join("=").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [name, value];
}

function loadTtsEnvFiles(): void {
  const envFiles = [
    join(process.cwd(), "..", ".env"),
    join(process.cwd(), ".env"),
    join(process.cwd(), ".env.tts"),
    join(homedir(), ".quje-agent", "tts.env"),
  ];

  for (const envFile of envFiles) {
    if (!existsSync(envFile)) continue;
    try {
      for (const line of readFileSync(envFile, "utf-8").split(/\r?\n/)) {
        const parsed = parseEnvLine(line);
        if (!parsed) continue;
        const [name, value] = parsed;
        process.env[name] ??= value;
      }
    } catch (err) {
      console.warn(`[TTS] Failed to read env file ${envFile}:`, err);
    }
  }
}

loadTtsEnvFiles();

function envCandidates(backend: TtsPythonBackend): PythonCandidate[] {
  const envNames: Record<TtsPythonBackend, string[]> = {
    kokoro: ["KOKORO_TTS_PYTHON_OVERRIDE", "KOKORO_TTS_PYTHON"],
    "qwen3-tts": ["QWEN3_TTS_PYTHON_OVERRIDE", "QWEN3_TTS_PYTHON"],
    "supertonic-3": ["SUPERTONIC_TTS_PYTHON_OVERRIDE", "SUPERTONIC_TTS_PYTHON"],
  };

  return [
    ...envNames[backend].flatMap((name) => {
      const value = process.env[name];
      return value ? [{ path: value, source: name }] : [];
    }),
    ...(process.env.TTS_PYTHON_OVERRIDE ? [{ path: process.env.TTS_PYTHON_OVERRIDE, source: "TTS_PYTHON_OVERRIDE" }] : []),
  ];
}

function defaultCandidates(backend: TtsPythonBackend): PythonCandidate[] {
  const serverVenv = join(process.cwd(), ".venv", "bin", "python");
  const repoVenv = join(process.cwd(), "..", ".venv", "bin", "python");
  const backendVenv = join(process.cwd(), "..", ".venv-tts", backend, "bin", "python");

  if (backend === "kokoro") {
    return [
      { path: backendVenv, source: `.venv-tts/${backend}` },
      { path: serverVenv, source: "server .venv" },
      { path: repoVenv, source: "repo .venv" },
    ];
  }

  return [
    { path: backendVenv, source: `.venv-tts/${backend}` },
    { path: repoVenv, source: "repo .venv" },
    { path: serverVenv, source: "server .venv" },
  ];
}

function candidatesForBackend(backend: TtsPythonBackend): PythonCandidate[] {
  const seen = new Set<string>();
  return [...envCandidates(backend), ...defaultCandidates(backend), { path: "python3", source: "system python3" }].filter((candidate) => {
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

function checkCandidate(candidate: PythonCandidate, requiredImports: string[]): Promise<TtsPythonStatus["candidates"][number]> {
  if (candidate.path.includes("/") && !existsSync(candidate.path)) {
    return Promise.resolve({ ...candidate, available: false, error: "Python interpreter not found" });
  }

  const script = [
    "import importlib.util, json, sys",
    `mods = ${JSON.stringify(requiredImports)}`,
    "missing = [m for m in mods if importlib.util.find_spec(m) is None]",
    "print(json.dumps({'missing': missing}))",
    "sys.exit(1 if missing else 0)",
  ].join("; ");

  return new Promise((resolve) => {
    const proc = spawn(candidate.path, ["-c", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ ...candidate, available: false, error: "Python import check timed out" });
    }, 15000);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ ...candidate, available: false, error: err.message });
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      let missingImports: string[] = [];
      try {
        const parsed = JSON.parse(stdout.trim().split("\n").at(-1) || "{}");
        missingImports = Array.isArray(parsed.missing) ? parsed.missing : [];
      } catch {
        resolve({ ...candidate, available: false, error: stderr.trim() || "Could not inspect Python imports" });
        return;
      }

      resolve({
        ...candidate,
        available: missingImports.length === 0,
        ...(missingImports.length > 0 && { missingImports }),
        ...(stderr.trim() && code !== 0 && { error: stderr.trim() }),
      });
    });
  });
}

export async function getTtsPythonStatus(backend: TtsPythonBackend): Promise<TtsPythonStatus> {
  const requiredImports = REQUIRED_IMPORTS[backend];
  const candidates = await Promise.all(candidatesForBackend(backend).map((candidate) => checkCandidate(candidate, requiredImports)));
  const selected = candidates.find((candidate) => candidate.available);

  if (selected) {
    return {
      available: true,
      pythonPath: selected.path,
      source: selected.source,
      requiredImports,
      installCommand: BACKEND_INSTALL_COMMANDS[backend],
      candidates,
    };
  }

  return {
    available: false,
    requiredImports,
    installCommand: BACKEND_INSTALL_COMMANDS[backend],
    candidates,
    error: `No Python interpreter found with required imports: ${requiredImports.join(", ")}. Run ${BACKEND_INSTALL_COMMANDS[backend]} or set a backend-specific Python override.`,
  };
}

export async function resolveTtsPython(backend: TtsPythonBackend): Promise<TtsPythonResolution> {
  const status = await getTtsPythonStatus(backend);
  if (!status.available || !status.pythonPath || !status.source) {
    const candidateSummary = status.candidates
      .map((candidate) => {
        const missing = candidate.missingImports?.length ? ` missing ${candidate.missingImports.join(", ")}` : "";
        const error = candidate.error ? ` ${candidate.error}` : "";
        return `${candidate.source} (${candidate.path}):${missing}${error || (candidate.available ? " ok" : "")}`.trim();
      })
      .join("; ");
    throw new Error(`${status.error}. Checked: ${candidateSummary}`);
  }

  return {
    pythonPath: status.pythonPath,
    source: status.source,
    requiredImports: status.requiredImports,
  };
}

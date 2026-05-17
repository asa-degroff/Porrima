import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
  error?: string;
  candidates: Array<{ path: string; source: string; available: boolean; missingImports?: string[]; error?: string }>;
}

const REQUIRED_IMPORTS: Record<TtsPythonBackend, string[]> = {
  kokoro: ["numpy", "kokoro"],
  "qwen3-tts": ["qwen_tts", "torch", "soundfile"],
  "supertonic-3": ["supertonic", "soundfile", "numpy"],
};

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

  if (backend === "kokoro") {
    return [
      { path: serverVenv, source: "server .venv" },
      { path: repoVenv, source: "repo .venv" },
    ];
  }

  return [
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
      candidates,
    };
  }

  return {
    available: false,
    requiredImports,
    candidates,
    error: `No Python interpreter found with required imports: ${requiredImports.join(", ")}`,
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

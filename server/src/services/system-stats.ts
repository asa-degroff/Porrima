import { promises as fs } from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GpuInfo {
  id: string; // "card0", "card1"
  name: string;
  driver: "amdgpu" | "nvidia" | "i915" | "unknown";
  usage: number; // 0-100, -1 if unavailable
  vramTotal: number; // bytes, 0 if unavailable
  vramUsed: number; // bytes, 0 if unavailable
  temperature: number; // celsius, -1 if unavailable
}

export interface SystemStatsSample {
  timestamp: number;
  cpu: { usage: number }; // 0-100
  ram: { total: number; available: number; used: number }; // bytes
  swap: { total: number; free: number; used: number }; // bytes
  gpus: GpuInfo[];
}

// ---------------------------------------------------------------------------
// Circular buffer
// ---------------------------------------------------------------------------

let history: SystemStatsSample[] = [];
let bufferSeconds = 60; // default: 1 minute
let pollIntervalMs = 2000; // 2 seconds
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastSample: SystemStatsSample | null = null;
let lastCpuStats: { total: number; idle: number; timestamp: number } | null = null;
let hiddenGpuIds = new Set<string>();

export function setHistoryDuration(seconds: number) {
  bufferSeconds = seconds;
  pruneHistory();
}

export function getHistoryDuration(): number {
  return bufferSeconds;
}

export function setHiddenGpus(ids: string[]) {
  hiddenGpuIds = new Set(ids);
}

export function getHiddenGpus(): string[] {
  return Array.from(hiddenGpuIds);
}

export function getHistory(): SystemStatsSample[] {
  pruneHistory();
  return history.map((s) => ({
    ...s,
    gpus: s.gpus.filter((g) => !hiddenGpuIds.has(g.id)),
  }));
}

export function getCurrent(): SystemStatsSample | null {
  if (!lastSample) return null;
  return {
    ...lastSample,
    gpus: lastSample.gpus.filter((g) => !hiddenGpuIds.has(g.id)),
  };
}

function pruneHistory() {
  const cutoff = Date.now() - bufferSeconds * 1000;
  while (history.length > 0 && history[0].timestamp < cutoff) {
    history.shift();
  }
}

// ---------------------------------------------------------------------------
// CPU usage from /proc/stat
// ---------------------------------------------------------------------------

async function readCpuStats(): Promise<{ total: number; idle: number }> {
  const content = await fs.readFile("/proc/stat", "utf-8");
  const line = content.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return { total: 0, idle: 0 };
  const parts = line.trim().split(/\s+/);
  // cpu user nice system idle iowait irq softirq steal guest guest_nice
  const vals = parts.slice(1).map(Number);
  const idle = vals[3] + (vals[4] ?? 0); // idle + iowait
  const total = vals.reduce((a, b) => a + b, 0);
  return { total, idle };
}

function computeCpuUsage(stats: { total: number; idle: number }): number {
  if (!lastCpuStats) return -1;
  const idleDelta = stats.idle - lastCpuStats.idle;
  const totalDelta = stats.total - lastCpuStats.total;
  if (totalDelta === 0) return 0;
  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
}

// ---------------------------------------------------------------------------
// RAM / Swap from /proc/meminfo
// ---------------------------------------------------------------------------

async function readMeminfo(): Promise<{
  ram: { total: number; available: number; used: number };
  swap: { total: number; free: number; used: number };
}> {
  const content = await fs.readFile("/proc/meminfo", "utf-8");
  const parse = (key: string): number => {
    const match = content.match(new RegExp(`${key}:\\s+(\\d+)`));
    return match ? parseInt(match[1], 10) * 1024 : 0; // kB → bytes
  };
  const ramTotal = parse("MemTotal");
  const ramAvailable = parse("MemAvailable");
  const swapTotal = parse("SwapTotal");
  const swapFree = parse("SwapFree");
  return {
    ram: { total: ramTotal, available: ramAvailable, used: ramTotal - ramAvailable },
    swap: { total: swapTotal, free: swapFree, used: swapTotal - swapFree },
  };
}

// ---------------------------------------------------------------------------
// GPU detection and stats
// ---------------------------------------------------------------------------

// PCI vendor IDs
const VENDOR_AMD = "0x1002";
const VENDOR_NVIDIA = "0x10de";
const VENDOR_INTEL = "0x8086";

// AMD GPU codenames — PCI device ID → LLVM gfx target name
// Sources: ROCm GPU hardware specs, Coelacanth's Dream AMDGPU database,
// LLVM AMDGPUUsage.rst, Gentoo amdgpu_targets USE flags, linux kernel amdgpu.ids
const AMD_CHIP_NAMES: Record<string, string> = {
  // ── RDNA 4 (GFX12) ────────────────────────────────────────────────────────
  "0x7590": "gfx1200", // Navi44 — RX 9060 / 9060 XT / 9060 XT LP
  "0x7550": "gfx1201", // Navi48 — RX 9070 / 9070 XT / 9070 GRE
  "0x7551": "gfx1201", // Navi48 — AI PRO R9700 / R9700S / R9600D

  // ── RDNA 3 — Navi31 / GC 11.0.0 (gfx1100) ───────────────────────────────
  "0x73a8": "gfx1100", // Navi31 early/dev
  "0x7448": "gfx1100", // Pro W7900
  "0x7449": "gfx1100", // Pro W7800 48GB
  "0x744a": "gfx1100", // Pro W7900 Dual Slot
  "0x744b": "gfx1100", // Pro W7900D
  "0x744c": "gfx1100", // RX 7900 XTX / XT / GRE, 7900M
  "0x745e": "gfx1100", // Pro W7800

  // ── RDNA 3 — Navi32 / GC 11.0.3 (gfx1101) ───────────────────────────────
  "0x7460": "gfx1101", // Pro V710
  "0x7461": "gfx1101", // Pro V710
  "0x7470": "gfx1101", // Pro W7700
  "0x747e": "gfx1101", // RX 7800 XT / 7700 XT / 7700 / 7800M

  // ── RDNA 3 — Navi33 / GC 11.0.2 (gfx1102) ───────────────────────────────
  "0x7480": "gfx1102", // RX 7600 / 7600 XT / 7650 GRE / 7600S / 7700S
  "0x7483": "gfx1102", // RX 7600M / 7600M XT
  "0x7489": "gfx1102", // Pro W7500
  "0x7499": "gfx1102", // RX 7300 / 7400 / Pro W7400

  // ── RDNA 3 APU — Phoenix / GC 11.0.1 (gfx1103) ──────────────────────────
  // No discrete PCI IDs map to gfx1103 — it's an iGPU (Radeon 780M / 700M)
  // detected via iGPU path rather than this PCI ID table

  // ── RDNA 3.5 APUs — Strix Point / etc (gfx1150 / gfx1151 / gfx1152) ────
  // These are iGPUs (Radeon 890M / 8060S / 860M), not discrete PCI devices

  // ── RDNA 2 — Navi21 / Sienna Cichlid (gfx1030) ──────────────────────────
  "0x73a0": "gfx1030", // Pro V620 / RX 6950 XT
  "0x73a1": "gfx1030", // Pro V620
  "0x73a2": "gfx1030",
  "0x73a3": "gfx1030", // Pro W6800
  "0x73a4": "gfx1030",
  "0x73a5": "gfx1030", // RX 6950 XT
  "0x73ab": "gfx1030",
  "0x73ac": "gfx1030",
  "0x73ad": "gfx1030",
  "0x73ae": "gfx1030", // Pro V620
  "0x73af": "gfx1030", // RX 6900 XT
  "0x73bd": "gfx1030",
  "0x73bf": "gfx1030", // RX 6900 XT / 6800 XT / 6800

  // ── RDNA 2 — Navi22 / Navy Flounder (gfx1031) ──────────────────────────
  "0x73c0": "gfx1031",
  "0x73c1": "gfx1031",
  "0x73c3": "gfx1031",
  "0x73da": "gfx1031",
  "0x73db": "gfx1031",
  "0x73dc": "gfx1031",
  "0x73dd": "gfx1031",
  "0x73de": "gfx1031",
  "0x73df": "gfx1031", // RX 6750 XT / 6700 XT / 6700 / 6700M

  // ── RDNA 2 — Navi23 / Dimgrey Cavefish (gfx1032) ───────────────────────
  "0x73e0": "gfx1032",
  "0x73e1": "gfx1032", // Pro W6600M
  "0x73e2": "gfx1032",
  "0x73e3": "gfx1032", // Pro W6600
  "0x73e8": "gfx1032",
  "0x73e9": "gfx1032",
  "0x73ea": "gfx1032",
  "0x73eb": "gfx1032",
  "0x73ec": "gfx1032",
  "0x73ed": "gfx1032",
  "0x73ef": "gfx1032", // RX 6800S / 6650 XT / 6700S
  "0x73ff": "gfx1032", // RX 6600 XT / 6600 / 6600M

  // ── RDNA 2 — Navi24 / Beige Goby (gfx1034) ─────────────────────────────
  "0x7420": "gfx1034",
  "0x7421": "gfx1034", // Pro W6500M
  "0x7422": "gfx1034", // Pro W6400
  "0x7423": "gfx1034", // Pro W6300M / W6300
  "0x7424": "gfx1034", // RX 6300
  "0x743f": "gfx1034", // RX 6500 XT / 6500M / 6400

  // ── RDNA 1 — Navi10 (gfx1010) ─────────────────────────────────────────
  "0x7310": "gfx1010", // Pro W5700X
  "0x7312": "gfx1010", // Pro W5700
  "0x7318": "gfx1010",
  "0x7319": "gfx1010", // Pro 5700 XT
  "0x731a": "gfx1010",
  "0x731b": "gfx1010", // Pro 5700
  "0x731e": "gfx1010",
  "0x731f": "gfx1010", // RX 5700 XT / 5700 / 5600 XT / 5600M

  // ── RDNA 1 — Navi14 (gfx1012) ─────────────────────────────────────────
  "0x7340": "gfx1012", // Pro W5500X
  "0x7341": "gfx1012", // Pro W5500
  "0x7343": "gfx1012",
  "0x7347": "gfx1012", // Pro W5500M
  "0x734f": "gfx1012", // Pro W5300M

  // ── Vega — Vega20 (gfx906) ─────────────────────────────────────────────
  "0x66a0": "gfx906",
  "0x66a1": "gfx906",  // MI50
  "0x66a2": "gfx906",
  "0x66a3": "gfx906",  // Pro Vega II
  "0x66a4": "gfx906",
  "0x66a7": "gfx906",
  "0x66af": "gfx906",  // Radeon VII / Pro VII

  // ── Vega — Vega10 (gfx900) ─────────────────────────────────────────────
  "0x6860": "gfx900",  // Instinct MI25
  "0x6861": "gfx900",  // Pro WX 9100
  "0x6862": "gfx900",  // Pro SSG
  "0x6863": "gfx900",  // Vega Frontier Edition
  "0x6867": "gfx900",  // Pro Vega 56
  "0x6868": "gfx900",  // Pro WX 8200
  "0x687f": "gfx900",  // RX Vega 56 / 64

  // ── GCN — Polaris (gfx803) ─────────────────────────────────────────────
  "0x67c0": "gfx803",  // Pro WX 7100
  "0x67c2": "gfx803",  // Pro V7350x2 / V7300X
  "0x67c4": "gfx803",  // Pro WX 7100
  "0x67c7": "gfx803",  // Pro WX 5100
  "0x67df": "gfx803",  // RX 580 / 570 / 590
  "0x67e0": "gfx803",  // Pro WX Series
  "0x67e3": "gfx803",  // Pro WX 4100
  "0x67e8": "gfx803",  // Pro WX Series
  "0x67ef": "gfx803",  // RX 560 / 460
  "0x67ff": "gfx803",  // RX 550 / 560

  // ── CDNA3 — gfx942 (MI300) ─────────────────────────────────────────────
  "0x74a0": "gfx942",  // MI300A
  "0x74a1": "gfx942",  // MI300X

  // ── CDNA2 — Aldebaran (gfx90a) ────────────────────────────────────────
  "0x7408": "gfx90a",
  "0x740c": "gfx90a",
  "0x740f": "gfx90a",
  "0x7410": "gfx90a",

  // ── CDNA — Arcturus (gfx908) ──────────────────────────────────────────
  "0x7388": "gfx908",
  "0x738c": "gfx908",  // MI100
  "0x738e": "gfx908",
  "0x7390": "gfx908",
};

async function discoverGpus(): Promise<GpuInfo[]> {
  const gpus: GpuInfo[] = [];
  try {
    // List card directories (not connectors like card0-DP-1)
    const entries = await fs.readdir("/sys/class/drm/");
    const cardDirs = entries.filter((e) => /^card\d+$/.test(e));

    for (const card of cardDirs) {
      const devicePath = `/sys/class/drm/${card}/device`;
      try {
        const vendor = (await fs.readFile(`${devicePath}/vendor`, "utf-8")).trim();
        const deviceId = (await fs.readFile(`${devicePath}/device`, "utf-8")).trim();
        const driver = (await fs.readFile(`${devicePath}/uevent`, "utf-8"))
          .split("\n")
          .find((l) => l.startsWith("DRIVER="))
          ?.split("=")[1];

        let name = `PCI ${vendor}:${deviceId}`;
        let gpuDriver: GpuInfo["driver"] = "unknown";

        if (vendor === VENDOR_AMD) {
          gpuDriver = "amdgpu";
          name = AMD_CHIP_NAMES[deviceId] || `AMD ${deviceId}`;
          const info = await readAmdGpuStats(card, devicePath);
          gpus.push({ id: card, name, driver: gpuDriver, ...info });
        } else if (vendor === VENDOR_NVIDIA) {
          gpuDriver = "nvidia";
          const info = await readNvidiaGpuStats(card);
          name = info.name || `NVIDIA GPU (${card})`;
          gpus.push({ id: card, name, driver: gpuDriver, ...info });
        } else if (vendor === VENDOR_INTEL) {
          gpuDriver = "i915";
          const info = await readIntelGpuStats(devicePath);
          name = `Intel iGPU (${card})`;
          gpus.push({ id: card, name, driver: gpuDriver, ...info });
        }
        // Unknown vendor — skip
      } catch {
        // Card may not have device/ accessible or may be a KMS-only card
        continue;
      }
    }
  } catch {
    // /sys/class/drm not available
  }

  return gpus;
}

async function readAmdGpuStats(
  card: string,
  devicePath: string,
): Promise<{ usage: number; vramTotal: number; vramUsed: number; temperature: number }> {
  const readSysfs = async (path: string): Promise<number> => {
    try {
      const raw = await fs.readFile(path, "utf-8");
      const v = parseInt(raw.trim(), 10);
      return isNaN(v) ? -1 : v;
    } catch {
      return -1;
    }
  };

  const [usage, vramTotal, vramUsed, temp] = await Promise.all([
    readSysfs(`${devicePath}/gpu_busy_percent`),
    readSysfs(`${devicePath}/mem_info_vram_total`),
    readSysfs(`${devicePath}/mem_info_vram_used`),
    readGpuTemperature(devicePath),
  ]);

  return { usage, vramTotal, vramUsed, temperature: temp };
}

async function readNvidiaGpuStats(
  card: string,
): Promise<{
  usage: number;
  vramTotal: number;
  vramUsed: number;
  temperature: number;
  name?: string;
}> {
  try {
    const idx = card.replace("card", "");
    const { stdout } = await execAsync(
      `nvidia-smi -i ${idx} --query-gpu=name,utilization.gpu,memory.total,memory.used,temperature.gpu --format=csv,noheader`,
    );
    const parts = stdout.trim().split(", ").map((s) => s.trim());
    const name = parts[0];
    const usage = parseFloat(parts[1].replace("%", ""));
    const vramTotal = parseNvidiaMemSize(parts[2]);
    const vramUsed = parseNvidiaMemSize(parts[3]);
    const temperature = parseFloat(parts[4].replace("°C", ""));
    return { usage, vramTotal, vramUsed, temperature, name };
  } catch {
    return { usage: -1, vramTotal: 0, vramUsed: 0, temperature: -1 };
  }
}

function parseNvidiaMemSize(s: string): number {
  // "XX.XX MiB" or "XX.XX GiB"
  const match = s.match(/([\d.]+)\s+(MiB|GiB)/);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  return match[2] === "GiB" ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
}

async function readIntelGpuStats(
  _devicePath: string,
): Promise<{ usage: number; vramTotal: number; vramUsed: number; temperature: number }> {
  // Intel i915 doesn't consistently expose utilization via sysfs
  // Some kernels expose gt_busy under /sys/class/drm/card*/device/gt*/
  // For now, report -1 for usage
  return { usage: -1, vramTotal: 0, vramUsed: 0, temperature: -1 };
}

// ---------------------------------------------------------------------------
// Temperature from hwmon
// ---------------------------------------------------------------------------

async function readGpuTemperature(devicePath: string): Promise<number> {
  try {
    // AMD hwmon: look for temp1_input (edge/GPU temp) under hwmon/*
    const hwmonDir = `${devicePath}/hwmon`;
    const entries = await fs.readdir(hwmonDir);
    for (const entry of entries) {
      const tempFile = `${hwmonDir}/${entry}/temp1_input`;
      try {
        const raw = await fs.readFile(tempFile, "utf-8");
        // Values are in millidegrees Celsius
        return parseInt(raw.trim(), 10) / 1000;
      } catch {
        continue;
      }
    }
  } catch {
    // hwmon not available
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

async function pollOnce() {
  try {
    const [meminfo, gpus] = await Promise.all([readMeminfo(), discoverGpus()]);

    // CPU: need two samples to compute delta
    const currentStats = await readCpuStats();
    let cpuUsage = -1;
    if (lastCpuStats) {
      cpuUsage = computeDelta(lastCpuStats, currentStats);
    }
    lastCpuStats = { ...currentStats, timestamp: Date.now() };

    const sample: SystemStatsSample = {
      timestamp: Date.now(),
      cpu: { usage: cpuUsage },
      ram: meminfo.ram,
      swap: meminfo.swap,
      gpus, // store all GPUs; filter at retrieval time
    };

    lastSample = sample;
    history.push(sample);
    pruneHistory();
  } catch (e: any) {
    console.warn("[system-stats] Poll error:", e.message);
  }
}

function computeDelta(
  prev: { total: number; idle: number },
  curr: { total: number; idle: number },
): number {
  const idleDelta = curr.idle - prev.idle;
  const totalDelta = curr.total - prev.total;
  if (totalDelta === 0) return 0;
  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

export function startSystemStatsPolling() {
  if (pollTimer) return;
  // Initial poll (CPU will be -1 for first sample — that's OK)
  pollOnce();
  pollTimer = setInterval(pollOnce, pollIntervalMs);
  console.log(`[system-stats] Polling every ${pollIntervalMs}ms, buffer ${bufferSeconds}s`);
}

export function stopSystemStatsPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Allow overriding poll interval (for testing)
function setPollInterval(ms: number) {
  pollIntervalMs = ms;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = setInterval(pollOnce, pollIntervalMs);
  }
}

// Export for testing/config
export const systemStatsConfig = { setPollInterval };

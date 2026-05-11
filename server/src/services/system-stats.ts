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
  return history;
}

export function getCurrent(): SystemStatsSample | null {
  return lastSample;
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

// AMD GPU codenames (RDNA / GCN chip families)
const AMD_CHIP_NAMES: Record<string, string> = {
  // RDNA 4
  "0x7590": "gfx1200", // RX 9060 / 9060 XT (Navi 44)
  "0x7550": "gfx1201", // RX 9070 / 9070 XT / 9070 GRE (Navi 48)
  "0x7551": "gfx1201", // AI PRO R9700 / R9700S / R9600D
  // RDNA 3
  "0x7448": "gfx1100", // Pro W7900
  "0x7449": "gfx1100", // Pro W7800 48GB
  "0x744a": "gfx1100", // Pro W7900 Dual Slot
  "0x744b": "gfx1100", // Pro W7900D
  "0x744c": "gfx1100", // RX 7900 XT/XTX/GRE, 7900M
  "0x745e": "gfx1100", // Pro W7800
  "0x7460": "gfx1103", // Pro V710
  "0x7461": "gfx1103", // Pro V710
  "0x7470": "gfx1103", // Pro W7700
  "0x747e": "gfx1103", // RX 7700 / 7700 XT / 7800 XT / 7800M
  "0x7480": "gfx1150", // RX 7600 / 7600 XT / 7650 GRE / 7600S / 7700S
  "0x7483": "gfx1150", // RX 7600M
  "0x7489": "gfx1150", // Pro W7500
  "0x7499": "gfx1150", // RX 7300 / 7400 / Pro W7400
  // RDNA 2
  "0x73a0": "gfx1030", // RX 6950 XT
  "0x73a1": "gfx1030", // RX 6900 XT
  "0x73a2": "gfx1030",
  "0x73a3": "gfx1031", // RX 6800 XT
  "0x73a4": "gfx1031",
  "0x73a5": "gfx1031",
  "0x73a8": "gfx1031",
  "0x73a9": "gfx1031",
  "0x73ab": "gfx1031",
  "0x73ac": "gfx1031",
  "0x73ad": "gfx1031",
  "0x73ae": "gfx1031",
  "0x73af": "gfx1031",
  "0x73bf": "gfx1035", // RX 6600M / 6600M XT
  "0x73c0": "gfx1032", // RX 6700 XT / 6800M
  "0x73c1": "gfx1032",
  "0x73c3": "gfx1032",
  "0x73da": "gfx1032",
  "0x73db": "gfx1032",
  "0x73dc": "gfx1032",
  "0x73dd": "gfx1032",
  "0x73de": "gfx1032",
  "0x73df": "gfx1032",
  "0x73e0": "gfx1031", // RX 6600 XT
  "0x73e1": "gfx1031",
  "0x73e2": "gfx1031",
  "0x73e3": "gfx1031",
  "0x73e8": "gfx1031",
  "0x73e9": "gfx1031",
  "0x73ea": "gfx1031",
  "0x73eb": "gfx1031",
  "0x73ec": "gfx1031",
  "0x73ed": "gfx1031",
  "0x73ef": "gfx1031", // RX 6600
  "0x73ff": "gfx1031", // RX 6600M
  // RDNA (Vega / Navi)
  "0x687f": "gfx906",  // RX Vega 56/64
  "0x687e": "gfx906",
  "0x687d": "gfx906",
  "0x687c": "gfx906",
  "0x67df": "gfx906",  // RX 580/570
  "0x67c0": "gfx1010", // RX 5600 XT / 5700 XT
  "0x67c1": "gfx1010",
  // MI300
  "0x74a0": "gfx942",  // MI300A
  "0x74a1": "gfx942",  // MI300X
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
      gpus: gpus.filter((g) => !hiddenGpuIds.has(g.id)),
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

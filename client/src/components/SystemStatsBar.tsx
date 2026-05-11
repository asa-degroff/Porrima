import { useMemo } from "react";
import type { SystemStatsSample, GpuInfo } from "../types";

interface Props {
  history: SystemStatsSample[];
  current?: SystemStatsSample | null;
}

const SVG_W = 36;
const SVG_H = 36;
const PAD = 2;

// Sparkline colors for multi-GPU overlapping lines
const GPU_COLORS = [
  "rgba(168, 85, 247, 0.9)",  // purple
  "rgba(236, 72, 153, 0.75)", // pink
  "rgba(59, 130, 246, 0.75)", // blue
  "rgba(52, 211, 153, 0.75)", // emerald
];

function Sparkline({ data, color, emptyColor }: {
  data: number[];
  color: string;
  emptyColor: string;
}) {
  const path = useMemo(() => {
    const valid = data.filter((v) => v >= 0);
    if (valid.length < 2) return null;

    const points = valid.map((v, i) => {
      const x = PAD + (i / (valid.length - 1)) * (SVG_W - PAD * 2);
      const yNorm = Math.max(0, Math.min(1, v / 100));
      const y = SVG_H - PAD - yNorm * (SVG_H - PAD * 2);
      return `${x},${y}`;
    });

    return points.join(" ");
  }, [data]);

  return (
    <svg width={SVG_W} height={SVG_H} className="shrink-0">
      {path ? (
        <polyline
          points={path}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <line
          x1={PAD}
          y1={SVG_H / 2}
          x2={SVG_W - PAD}
          y2={SVG_H / 2}
          stroke={emptyColor}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray="2 3"
        />
      )}
    </svg>
  );
}

function MultiSparkline({ series, emptyColor }: {
  series: { data: number[]; color: string }[];
  emptyColor: string;
}) {
  const paths = useMemo(() => {
    return series.map((s) => {
      const valid = s.data.filter((v) => v >= 0);
      if (valid.length < 2) return null;

      const points = valid.map((v, i) => {
        const x = PAD + (i / (valid.length - 1)) * (SVG_W - PAD * 2);
        const yNorm = Math.max(0, Math.min(1, v / 100));
        const y = SVG_H - PAD - yNorm * (SVG_H - PAD * 2);
        return `${x},${y}`;
      });

      return points.join(" ");
    });
  }, [series]);

  const hasData = paths.some((p) => p !== null);

  return (
    <svg width={SVG_W} height={SVG_H} className="shrink-0">
      {hasData ? (
        paths.map((path, i) =>
          path ? (
            <polyline
              key={i}
              points={path}
              fill="none"
              stroke={series[i].color}
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null,
        )
      ) : (
        <line
          x1={PAD}
          y1={SVG_H / 2}
          x2={SVG_W - PAD}
          y2={SVG_H / 2}
          stroke={emptyColor}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray="2 3"
        />
      )}
    </svg>
  );
}

function formatPct(value: number): string {
  if (value < 0) return "—";
  return `${value.toFixed(0)}%`;
}

// Compute current GPU utilization as average across GPUs
function getGpuAvgUsage(gpus: GpuInfo[]): number {
  if (!gpus.length) return -1;
  const valid = gpus.filter((g) => g.usage >= 0);
  if (!valid.length) return -1;
  return valid.reduce((a, b) => a + b.usage, 0) / valid.length;
}

// Compute current VRAM usage as average across GPUs
function getGpuAvgVramPct(gpus: GpuInfo[]): number {
  if (!gpus.length) return -1;
  const valid = gpus.filter((g) => g.vramTotal > 0);
  if (!valid.length) return -1;
  return valid.reduce((a, b) => a + (b.vramUsed / b.vramTotal) * 100, 0) / valid.length;
}

export function SystemStatsBar({ history, current }: Props) {
  // Build time-series data for each metric (most recent last)
  const cpuData = useMemo(
    () => history.map((s) => s.cpu.usage).slice(-30),
    [history],
  );

  const ramUsedData = useMemo(
    () => history.map((s) => {
      if (s.ram.total <= 0) return -1;
      return (s.ram.used / s.ram.total) * 100;
    }).slice(-30),
    [history],
  );

  // GPU utilization — multi-series for overlapping lines
  const gpuIndices = useMemo(() => {
    const indices = new Set<string>();
    for (const s of history) {
      for (const g of s.gpus) indices.add(g.id);
    }
    return Array.from(indices);
  }, [history]);

  const gpuUsageSeries = useMemo(() => {
    return gpuIndices.map((id, idx) => ({
      data: history.map((s) => {
        const gpu = s.gpus.find((g) => g.id === id);
        return gpu?.usage ?? -1;
      }).slice(-30),
      color: GPU_COLORS[idx % GPU_COLORS.length],
    }));
  }, [history, gpuIndices]);

  // VRAM usage — also multi-series
  const gpuVramSeries = useMemo(() => {
    return gpuIndices.map((id, idx) => {
      const total = history[history.length - 1]?.gpus.find((g) => g.id === id)?.vramTotal ?? 0;
      return {
        data: history.map((s) => {
          const gpu = s.gpus.find((g) => g.id === id);
          if (!gpu || gpu.vramTotal <= 0) return -1;
          return (gpu.vramUsed / gpu.vramTotal) * 100;
        }).slice(-30),
        color: GPU_COLORS[idx % GPU_COLORS.length],
      };
    });
  }, [history, gpuIndices]);

  // Current values
  const cpu = current?.cpu.usage ?? -1;
  const ramPct = current && current.ram.total > 0
    ? (current.ram.used / current.ram.total) * 100
    : -1;
  const gpuUsage = getGpuAvgUsage(current?.gpus ?? []);
  const gpuVramPct = getGpuAvgVramPct(current?.gpus ?? []);

  return (
    <div className="px-3 pb-2">
      <div className="grid grid-cols-4 gap-2">
        {/* CPU */}
        <StatBox
          label="CPU"
          value={formatPct(cpu)}
          sparkData={cpuData}
          color="rgba(var(--theme-accent), 0.9)"
        />

        {/* RAM */}
        <StatBox
          label="RAM"
          value={formatPct(ramPct)}
          sparkData={ramUsedData}
          color="rgba(52, 211, 153, 0.9)"
        />

        {/* GPU — overlapping lines for multi-GPU */}
        <MultiStatBox
          label="GPU"
          value={formatPct(gpuUsage)}
          series={gpuUsageSeries}
        />

        {/* VRAM — overlapping lines for multi-GPU */}
        <MultiStatBox
          label="VRAM"
          value={formatPct(gpuVramPct)}
          series={gpuVramSeries}
        />
      </div>
    </div>
  );
}

function StatBox({ label, value, sparkData, color }: {
  label: string;
  value: string;
  sparkData: number[];
  color: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="rounded-lg bg-black/20 border border-white/[0.05] p-1.5 flex items-center justify-center shadow-[inset_0_1px_7px_rgba(0,0,0,0.5)]">
        <Sparkline data={sparkData} color={color} emptyColor="rgba(148, 163, 184, 0.2)" />
      </div>
      <span className="text-[10px] text-white/50 font-mono">{value}</span>
      <span className="text-[9px] text-white/30">{label}</span>
    </div>
  );
}

function MultiStatBox({ label, value, series }: {
  label: string;
  value: string;
  series: { data: number[]; color: string }[];
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="rounded-lg bg-black/20 border border-white/[0.05] p-1.5 flex items-center justify-center shadow-[inset_0_1px_7px_rgba(0,0,0,0.5)]">
        <MultiSparkline series={series} emptyColor="rgba(148, 163, 184, 0.2)" />
      </div>
      <span className="text-[10px] text-white/50 font-mono">{value}</span>
      <span className="text-[9px] text-white/30">{label}</span>
    </div>
  );
}

import { useMemo } from "react";
import type { SystemStatsSample } from "../types";

interface Props {
  history: SystemStatsSample[];
  current?: SystemStatsSample | null;
}

// Compact sparkline: width ~40px, height ~20px
function Sparkline({ data, color, emptyColor }: {
  data: number[];
  color: string;
  emptyColor: string;
}) {
  const path = useMemo(() => {
    const valid = data.filter((v) => v >= 0);
    if (valid.length < 2) return null;

    const w = 40;
    const h = 20;
    const pad = 1;
    const min = 0;
    const max = 100;

    const points = valid.map((v, i) => {
      const x = pad + (i / (valid.length - 1)) * (w - pad * 2);
      const yNorm = Math.max(0, Math.min(1, (v - min) / (max - min)));
      const y = h - pad - yNorm * (h - pad * 2);
      return `${x},${y}`;
    });

    return points.join(" ");
  }, [data]);

  return (
    <svg width="40" height="20" className="shrink-0">
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
          x1="2"
          y1="10"
          x2="38"
          y2="10"
          stroke={emptyColor}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}G`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}T`;
}

function formatPct(value: number): string {
  if (value < 0) return "—";
  return `${value.toFixed(0)}%`;
}

function formatTemp(value: number): string {
  if (value < 0) return "—";
  return `${value.toFixed(0)}°`;
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

  const swapUsedData = useMemo(
    () => history.map((s) => {
      if (s.swap.total <= 0) return -1;
      return (s.swap.used / s.swap.total) * 100;
    }).slice(-30),
    [history],
  );

  // GPU data — one series per GPU
  const gpuIndices = useMemo(() => {
    const indices = new Set<string>();
    for (const s of history) {
      for (const g of s.gpus) indices.add(g.id);
    }
    return Array.from(indices);
  }, [history]);

  const gpuDataMap = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const id of gpuIndices) {
      map.set(id, history.map((s) => {
        const gpu = s.gpus.find((g) => g.id === id);
        return gpu?.usage ?? -1;
      }).slice(-30));
    }
    return map;
  }, [history, gpuIndices]);

  const gpuVramDataMap = useMemo(() => {
    const map = new Map<string, { used: number[]; total: number }>();
    for (const id of gpuIndices) {
      const usedSeries = history.map((s) => {
        const gpu = s.gpus.find((g) => g.id === id);
        return gpu?.vramUsed ?? 0;
      });
      const total = usedSeries.length > 0
        ? history[history.length - 1]?.gpus.find((g) => g.id === id)?.vramTotal ?? 0
        : 0;
      map.set(id, { used: usedSeries.slice(-30), total });
    }
    return map;
  }, [history, gpuIndices]);

  // Current values
  const cpu = current?.cpu.usage ?? -1;
  const ramUsed = current?.ram.used ?? 0;
  const ramTotal = current?.ram.total ?? 0;
  const swapUsed = current?.swap.used ?? 0;
  const swapTotal = current?.swap.total ?? 0;

  const gpuInfos = current?.gpus ?? [];

  return (
    <div className="px-3 pb-2">
      <div className="grid grid-cols-4 gap-2">
        {/* CPU */}
        <StatCard
          label="CPU"
          value={formatPct(cpu)}
          sparkData={cpuData}
          color="rgba(var(--theme-accent), 0.8)"
        />

        {/* RAM */}
        <StatCard
          label="RAM"
          value={`${formatBytes(ramUsed)}/${formatBytes(ramTotal)}`}
          sparkData={ramUsedData}
          color="rgba(52, 211, 153, 0.8)" // emerald
        />

        {/* Swap */}
        <StatCard
          label="Swap"
          value={`${formatBytes(swapUsed)}/${formatBytes(swapTotal)}`}
          sparkData={swapUsedData}
          color="rgba(251, 191, 36, 0.8)" // amber
        />

        {/* GPU(s) — show first GPU usage, or multi-GPU summary */}
        {gpuInfos.length === 0 ? (
          <StatCard label="GPU" value="—" sparkData={[]} color="rgba(148, 163, 184, 0.5)" />
        ) : gpuInfos.length === 1 ? (
          <GpuStatCard
            gpu={gpuInfos[0]}
            usageData={gpuDataMap.get(gpuInfos[0].id) ?? []}
            vramData={gpuVramDataMap.get(gpuInfos[0].id)}
          />
        ) : (
          <MultiGpuCard
            gpus={gpuInfos}
            usageMap={gpuDataMap}
            vramMap={gpuVramDataMap}
          />
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, sparkData, color }: {
  label: string;
  value: string;
  sparkData: number[];
  color: string;
}) {
  return (
    <div className="bg-white/5 rounded-lg p-1.5 flex flex-col items-center gap-0.5">
      <Sparkline data={sparkData} color={color} emptyColor="rgba(148, 163, 184, 0.25)" />
      <span className="text-[10px] text-white/50 font-mono">{value}</span>
      <span className="text-[9px] text-white/30">{label}</span>
    </div>
  );
}

function GpuStatCard({ gpu, usageData, vramData }: {
  gpu: { usage: number; vramTotal: number; vramUsed: number; temperature: number };
  usageData: number[];
  vramData?: { used: number[]; total: number };
}) {
  const vramPctData = useMemo(() => {
    if (!vramData || vramData.total <= 0) return [];
    return vramData.used.map((u) => (u / vramData.total) * 100);
  }, [vramData]);

  return (
    <div className="bg-white/5 rounded-lg p-1.5 flex flex-col items-center gap-0.5">
      <Sparkline data={usageData} color="rgba(168, 85, 247, 0.8)" emptyColor="rgba(148, 163, 184, 0.25)" />
      <span className="text-[10px] text-white/50 font-mono">
        {gpu.usage >= 0 ? `${gpu.usage.toFixed(0)}%` : "—"}{" "}
        <span className="text-white/30">{formatTemp(gpu.temperature)}</span>
      </span>
      <span className="text-[9px] text-white/30">GPU</span>
    </div>
  );
}

function MultiGpuCard({ gpus, usageMap, vramMap }: {
  gpus: Array<{ id: string; usage: number; vramTotal: number; vramUsed: number; temperature: number }>;
  usageMap: Map<string, number[]>;
  vramMap: Map<string, { used: number[]; total: number }>;
}) {
  return (
    <div className="bg-white/5 rounded-lg p-1.5 flex flex-col gap-1">
      {gpus.slice(0, 2).map((gpu) => {
        const usageData = usageMap.get(gpu.id) ?? [];
        return (
          <div key={gpu.id} className="flex items-center gap-1.5">
            <span className="text-[9px] text-white/40 shrink-0">{gpu.id}</span>
            <Sparkline data={usageData} color="rgba(168, 85, 247, 0.8)" emptyColor="rgba(148, 163, 184, 0.25)" />
            <span className="text-[10px] text-white/50 font-mono shrink-0">
              {gpu.usage >= 0 ? `${gpu.usage.toFixed(0)}%` : "—"}
              <span className="text-white/30 ml-0.5">{formatTemp(gpu.temperature)}</span>
            </span>
          </div>
        );
      })}
      {gpus.length > 2 && (
        <span className="text-[9px] text-white/30">+{gpus.length - 2} more</span>
      )}
    </div>
  );
}

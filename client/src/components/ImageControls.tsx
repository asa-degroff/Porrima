import { useState, useEffect, useRef } from "react";
import type { ImageGenerationParams } from "../types";
import type { QueueItem } from "../hooks/useImageSandbox";

const MODEL_PRESETS: Record<string, Partial<ImageGenerationParams>> = {
  "z-image-base": { steps: 30, cfgScale: 4.0, sampler: "euler", scheduler: "normal" },
  "z-image-turbo": { steps: 9, cfgScale: 0.0, sampler: "euler", scheduler: "sgm_uniform" },
};

const ASPECT_RATIOS = [
  { label: "1:1", ratio: 1, w: 1024, h: 1024 },
  { label: "16:9", ratio: 16 / 9, w: 1344, h: 768 },
  { label: "9:16", ratio: 9 / 16, w: 768, h: 1344 },
  { label: "4:3", ratio: 4 / 3, w: 1152, h: 896 },
  { label: "3:4", ratio: 3 / 4, w: 896, h: 1152 },
  { label: "Free", ratio: null, w: 1024, h: 1024 },
];

const STORAGE_KEY = "quje-image-settings";

interface Props {
  models: string[];
  generating: boolean;
  progress: { step: number; total: number } | null;
  onEnqueue: (params: ImageGenerationParams, batchCount: number) => void;
  onAbort: () => void;
  onAbortAll: () => void;
  onClearQueue: () => void;
  queue: QueueItem[];
  currentItem: QueueItem | null;
  initialParams?: Partial<ImageGenerationParams>;
}

export function ImageControls({ models, generating, progress, onEnqueue, onAbort, onAbortAll, onClearQueue, queue, currentItem, initialParams }: Props) {
  const [positivePrompt, setPositivePrompt] = useState(initialParams?.positivePrompt || "");
  const [negativePrompt, setNegativePrompt] = useState(initialParams?.negativePrompt || "");
  const [showNegative, setShowNegative] = useState(false);
  const [model, setModel] = useState(initialParams?.model || models[0] || "");
  const [steps, setSteps] = useState(initialParams?.steps || 30);
  const [cfgScale, setCfgScale] = useState(initialParams?.cfgScale || 4.0);
  const [aspectRatio, setAspectRatio] = useState<string>("1:1");
  const [width, setWidth] = useState<string | number>(initialParams?.width || 1024);
  const [height, setHeight] = useState<string | number>(initialParams?.height || 1024);
  const [seed, setSeed] = useState<string>(initialParams?.seed?.toString() || "-1");
  const [sampler, setSampler] = useState(initialParams?.sampler || "euler");
  const [scheduler, setScheduler] = useState(initialParams?.scheduler || "normal");
  const [lastSeed, setLastSeed] = useState<number | null>(null);
  const [batchCount, setBatchCount] = useState(1);

  // Track if user is manually editing width/height (for Free mode)
  const editingWidthRef = useRef(false);
  const editingHeightRef = useRef(false);
  const initialMountRef = useRef(true);

  // Load saved settings on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const settings = JSON.parse(saved);
        if (settings.width !== undefined) setWidth(settings.width);
        if (settings.height !== undefined) setHeight(settings.height);
        if (settings.aspectRatio) setAspectRatio(settings.aspectRatio);
        if (settings.steps) setSteps(settings.steps);
        if (settings.cfgScale !== undefined) setCfgScale(settings.cfgScale);
        if (settings.sampler) setSampler(settings.sampler);
        if (settings.scheduler) setScheduler(settings.scheduler);
        if (settings.model) setModel(settings.model);
        if (settings.showNegative !== undefined) setShowNegative(settings.showNegative);
        if (settings.negativePrompt) setNegativePrompt(settings.negativePrompt);
        if (settings.seed !== undefined) setSeed(settings.seed.toString());
      }
    } catch {}
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist all settings when they change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        width,
        height,
        aspectRatio,
        steps,
        cfgScale,
        sampler,
        scheduler,
        model,
        showNegative,
        negativePrompt,
        seed,
      }));
    } catch {}
  }, [width, height, aspectRatio, steps, cfgScale, sampler, scheduler, model, showNegative, negativePrompt, seed]);

  // Handle aspect ratio button click
  const handleAspectRatioClick = (label: string, w: number, h: number, ratio: number | null) => {
    setAspectRatio(label);
    if (label === "Free") return;
    setWidth(w);
    setHeight(h);
  };

  // Update model when models list arrives
  useEffect(() => {
    if (!model && models.length > 0) {
      setModel(models[0]);
    }
  }, [models, model]);

  // Apply presets when model changes (skip initial mount — localStorage already loaded)
  useEffect(() => {
    if (initialMountRef.current) {
      initialMountRef.current = false;
      return;
    }
    let preset: Partial<ImageGenerationParams> | undefined;
    if (model.includes("turbo")) {
      preset = MODEL_PRESETS["z-image-turbo"];
    } else if (model.includes("z_image") || model.includes("z-image")) {
      preset = MODEL_PRESETS["z-image-base"];
    }
    if (preset) {
      setSteps(preset.steps ?? steps);
      setCfgScale(preset.cfgScale ?? cfgScale);
      setSampler(preset.sampler ?? sampler);
      setScheduler(preset.scheduler ?? scheduler);
    }
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply initialParams when "Use as starting point" is clicked
  useEffect(() => {
    if (initialParams) {
      if (initialParams.positivePrompt) setPositivePrompt(initialParams.positivePrompt);
      if (initialParams.negativePrompt) {
        setNegativePrompt(initialParams.negativePrompt);
        setShowNegative(true);
      }
      if (initialParams.model) setModel(initialParams.model);
      if (initialParams.steps) setSteps(initialParams.steps);
      if (initialParams.cfgScale !== undefined) setCfgScale(initialParams.cfgScale);
      if (initialParams.width) setWidth(initialParams.width);
      if (initialParams.height) setHeight(initialParams.height);
      if (initialParams.seed !== undefined) setSeed(initialParams.seed.toString());
      if (initialParams.sampler) setSampler(initialParams.sampler);
      if (initialParams.scheduler) setScheduler(initialParams.scheduler);
    }
  }, [initialParams]);

  // Handle width change - adjust height to maintain aspect ratio
  const handleWidthChange = (value: number) => {
    editingWidthRef.current = true;
    setWidth(value);

    if (aspectRatio !== "Free") {
      const ar = ASPECT_RATIOS.find((a) => a.label === aspectRatio);
      if (ar && ar.ratio !== null) {
        // Calculate exact height from ratio
        setHeight(Math.round(value / ar.ratio));
      }
    }
    setTimeout(() => { editingWidthRef.current = false; }, 100);
  };

  // Handle height change - adjust width to maintain aspect ratio
  const handleHeightChange = (value: number) => {
    editingHeightRef.current = true;
    setHeight(value);

    if (aspectRatio !== "Free") {
      const ar = ASPECT_RATIOS.find((a) => a.label === aspectRatio);
      if (ar && ar.ratio !== null) {
        setWidth(Math.round(value * ar.ratio));
      }
    }
    setTimeout(() => { editingHeightRef.current = false; }, 100);
  };

  const handleGenerate = () => {
    if (!positivePrompt.trim()) return;

    // Apply defaults for empty/invalid dimensions
    const finalWidth = typeof width === 'number' ? width : parseInt(width) || 1024;
    const finalHeight = typeof height === 'number' ? height : parseInt(height) || 1024;

    const parsedSeed = parseInt(seed);
    onEnqueue({
      positivePrompt: positivePrompt.trim(),
      negativePrompt: negativePrompt.trim() || undefined,
      model,
      steps,
      cfgScale,
      width: finalWidth,
      height: finalHeight,
      seed: isNaN(parsedSeed) || parsedSeed < 0 ? undefined : parsedSeed,
      sampler,
      scheduler,
    }, batchCount);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleGenerate();
    }
  };

  const isTurbo = model.includes("turbo");
  const progressPercent = progress ? Math.round((progress.step / progress.total) * 100) : 0;
  const totalPending = queue.length + (generating ? 1 : 0);

  return (
    <div className="space-y-4">
      {/* Positive Prompt */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-white/50">Prompt</label>
        <textarea
          value={positivePrompt}
          onChange={(e) => setPositivePrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={16}
          className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-sm text-white/90 placeholder-white/30 resize-y outline-none focus:ring-1 focus:ring-amber-400/30 focus:border-amber-400/30 transition-colors"
          placeholder="A detailed description of the image..."
        />
      </div>

      {/* Negative Prompt (collapsible) */}
      <div>
        <button
          onClick={() => setShowNegative(!showNegative)}
          className="text-xs text-white/40 hover:text-white/60 transition-colors"
        >
          {showNegative ? "- Hide" : "+ Show"} negative prompt
        </button>
        {showNegative && (
          <textarea
            value={negativePrompt}
            onChange={(e) => setNegativePrompt(e.target.value)}
            rows={2}
            className="w-full mt-1.5 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white/70 placeholder-white/25 resize-y outline-none focus:ring-1 focus:ring-amber-400/20 transition-colors"
            placeholder="What to avoid..."
          />
        )}
      </div>

      {/* Model */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-white/50">Model</label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-sm text-white/80 outline-none hover:bg-white/10 focus:ring-1 focus:ring-amber-400/30 transition-all cursor-pointer appearance-none"
        >
          {models.map((m) => (
            <option key={m} value={m} className="bg-slate-900 text-white">
              {m}
            </option>
          ))}
          {models.length === 0 && (
            <option value="" className="bg-slate-900 text-white/50">No models found</option>
          )}
        </select>
      </div>

      {/* Steps */}
      <div className="space-y-1.5">
        <div className="flex justify-between">
          <label className="text-xs font-medium text-white/50">Steps</label>
          <span className="text-xs text-white/40">{steps}</span>
        </div>
        <input
          type="range"
          min={1}
          max={50}
          value={steps}
          onChange={(e) => setSteps(parseInt(e.target.value))}
          className="w-full accent-amber-400"
        />
      </div>

      {/* CFG Scale */}
      <div className="space-y-1.5">
        <div className="flex justify-between">
          <label className="text-xs font-medium text-white/50">
            CFG Scale {isTurbo && <span className="text-amber-400/60">(auto: 0)</span>}
          </label>
          <span className="text-xs text-white/40">{cfgScale.toFixed(1)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={20}
          step={0.5}
          value={cfgScale}
          onChange={(e) => setCfgScale(parseFloat(e.target.value))}
          disabled={isTurbo}
          className="w-full accent-amber-400 disabled:opacity-40"
        />
      </div>

      {/* Dimensions */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-white/50">Size</label>
        <div className="flex gap-1.5 flex-wrap">
          {ASPECT_RATIOS.map((ar) => (
            <button
              key={ar.label}
              onClick={() => handleAspectRatioClick(ar.label, ar.w, ar.h, ar.ratio)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-all ${
                aspectRatio === ar.label
                  ? "bg-amber-500/20 border-amber-400/30 text-amber-300"
                  : "bg-white/5 border-white/10 text-white/50 hover:bg-white/10"
              }`}
            >
              {ar.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-center">
          <input
            type="number"
            value={width}
            onChange={(e) => handleWidthChange(parseInt(e.target.value) || 1024)}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white/70 outline-none focus:ring-1 focus:ring-amber-400/20 transition-all"
            min={256}
            max={2048}
            step={64}
          />
          <span className="text-white/30 text-xs">x</span>
          <input
            type="number"
            value={height}
            onChange={(e) => handleHeightChange(parseInt(e.target.value) || 1024)}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white/70 outline-none focus:ring-1 focus:ring-amber-400/20 transition-all"
            min={256}
            max={2048}
            step={64}
          />
        </div>
        {aspectRatio === "Free" ? (
          <div className="text-[10px] text-white/30">
            Free mode: width and height can be adjusted independently
          </div>
        ) : (
          <div className="text-[10px] text-white/30">
            Adjusting one dimension auto-calculates the other to maintain {aspectRatio} ratio
          </div>
        )}
      </div>

      {/* Seed */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-white/50">Seed</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white/70 outline-none focus:ring-1 focus:ring-amber-400/20 transition-all font-mono"
            placeholder="-1 (random)"
          />
          {lastSeed !== null && (
            <button
              onClick={() => setSeed(lastSeed.toString())}
              className="px-2 py-1 rounded-md text-[10px] bg-white/5 border border-white/10 text-white/40 hover:text-white/60 hover:bg-white/10 transition-all"
              title={`Reuse: ${lastSeed}`}
            >
              Reuse
            </button>
          )}
        </div>
      </div>

      {/* Sampler & Scheduler */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[10px] font-medium text-white/40">Sampler</label>
          <select
            value={sampler}
            onChange={(e) => setSampler(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white/70 outline-none cursor-pointer appearance-none"
          >
            {["euler", "euler_ancestral", "heun", "dpm_2", "dpm_2_ancestral", "lms", "dpmpp_2s_ancestral", "dpmpp_sde", "dpmpp_2m"].map((s) => (
              <option key={s} value={s} className="bg-slate-900">{s}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-medium text-white/40">Scheduler</label>
          <select
            value={scheduler}
            onChange={(e) => setScheduler(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white/70 outline-none cursor-pointer appearance-none"
          >
            {["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta"].map((s) => (
              <option key={s} value={s} className="bg-slate-900">{s}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Batch Count & Generate */}
      <div className="space-y-2">
        <div className="flex gap-2 items-end">
          <div className="space-y-1 w-20">
            <label className="text-[10px] font-medium text-white/40">Batch</label>
            <input
              type="number"
              min={1}
              max={32}
              value={batchCount}
              onChange={(e) => setBatchCount(Math.max(1, Math.min(32, parseInt(e.target.value) || 1)))}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white/70 outline-none focus:ring-1 focus:ring-amber-400/20 transition-all text-center"
            />
          </div>
          <button
            onClick={handleGenerate}
            disabled={!positivePrompt.trim() || models.length === 0}
            className="flex-1 px-4 py-[7px] rounded-xl text-sm font-medium bg-amber-500/20 border border-amber-400/25 text-amber-300 hover:bg-amber-500/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {totalPending > 0
              ? `Enqueue${batchCount > 1 ? ` ${batchCount}` : ""}`
              : `Generate${batchCount > 1 ? ` ${batchCount}` : ""}`
            }
          </button>
        </div>
      </div>

      {/* Current generation progress */}
      {generating && (
        <div className="space-y-2">
          <div className="w-full bg-white/5 rounded-full h-2 overflow-hidden">
            <div
              className="h-full bg-amber-400/70 rounded-full transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-white/40">
              {progress ? `Step ${progress.step}/${progress.total}` : "Starting..."}
              {currentItem && currentItem.batchTotal > 1 && (
                <span className="text-white/30"> ({currentItem.batchIndex}/{currentItem.batchTotal})</span>
              )}
            </span>
            <button
              onClick={queue.length > 0 ? onAbortAll : onAbort}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/15 border border-red-400/20 text-red-300 hover:bg-red-500/25 transition-all"
            >
              {queue.length > 0 ? "Cancel All" : "Cancel"}
            </button>
          </div>
        </div>
      )}

      {/* Queue display */}
      {queue.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-white/40">
              Queue ({queue.length} pending)
            </span>
            <button
              onClick={onClearQueue}
              className="text-[10px] text-red-400/60 hover:text-red-400 transition-colors"
            >
              Clear
            </button>
          </div>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {queue.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2 px-2 py-1 rounded-md bg-white/[0.03] border border-white/5"
              >
                <div className="w-1.5 h-1.5 rounded-full bg-amber-400/40 shrink-0" />
                <span className="text-[10px] text-white/40 truncate flex-1">{item.promptPreview}</span>
                {item.batchTotal > 1 && (
                  <span className="text-[10px] text-white/25 shrink-0">{item.batchIndex}/{item.batchTotal}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

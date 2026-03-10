import { useState } from "react";
import type { GeneratedImage, ImageGenerationParams } from "../types";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface Props {
  image: GeneratedImage;
  onUseParams: (params: Partial<ImageGenerationParams>) => void;
  onOpenLightbox?: (image: GeneratedImage) => void;
}

export function ImageDetails({ image, onUseParams, onOpenLightbox }: Props) {
  const p = image.params;
  const [imageLoaded, setImageLoaded] = useState(false);

  const handleUseParams = () => {
    onUseParams({
      positivePrompt: p.positivePrompt,
      negativePrompt: p.negativePrompt,
      model: p.model,
      steps: p.steps,
      cfgScale: p.cfgScale,
      width: p.width,
      height: p.height,
      seed: image.resolvedSeed,
      sampler: p.sampler,
      scheduler: p.scheduler,
    });
  };

  const handleDownload = () => {
    const a = document.createElement("a");
    a.href = image.url;
    a.download = `quje-${image.resolvedSeed}.png`;
    a.click();
  };

  const handleImageClick = () => {
    onOpenLightbox?.(image);
  };

  return (
    <div className="space-y-4">
      {/* Preview */}
      <div
        className="rounded-xl overflow-hidden border border-white/10 bg-black/30 cursor-pointer"
        onClick={handleImageClick}
      >
        <img
          src={image.url}
          alt={p.positivePrompt.slice(0, 80)}
          className="w-full object-contain max-h-[400px]"
          onLoad={() => setImageLoaded(true)}
        />
        {!imageLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
            <div className="w-6 h-6 border-2 border-white/30 border-t-white/80 rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Prompt */}
      <div className="space-y-2">
        <label className="text-[10px] font-medium text-white/40 uppercase tracking-wider">Prompt</label>
        <div className="text-xs text-white/70 leading-relaxed markdown-body">
          <MarkdownRenderer content={p.positivePrompt} />
        </div>
        {p.negativePrompt && (
          <>
            <label className="text-[10px] font-medium text-white/40 uppercase tracking-wider mt-2 block">Negative</label>
            <div className="text-xs text-white/50 leading-relaxed markdown-body">
              <MarkdownRenderer content={p.negativePrompt} />
            </div>
          </>
        )}
      </div>

      {/* Params */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <Param label="Model" value={p.model} />
        <Param label="Seed" value={image.resolvedSeed.toString()} mono />
        <Param label="Steps" value={p.steps.toString()} />
        <Param label="CFG" value={p.cfgScale.toFixed(1)} />
        <Param label="Size" value={`${p.width}x${p.height}`} />
        <Param label="Sampler" value={p.sampler || "euler"} />
        <Param label="Scheduler" value={p.scheduler || "normal"} />
      </div>

      {/* Actions */}
      <div className="space-y-2 pt-1">
        <button
          onClick={handleUseParams}
          className="w-full px-3 py-2 rounded-lg text-xs font-medium bg-amber-500/15 border border-amber-400/20 text-amber-300 hover:bg-amber-500/25 transition-all"
        >
          Use as starting point
        </button>
        <button
          onClick={handleDownload}
          className="w-full px-3 py-2 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/60 hover:text-white/80 hover:bg-white/10 transition-all"
        >
          Download
        </button>
      </div>
    </div>
  );
}

function Param({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <span className="text-white/40">{label}</span>
      <span className={`text-white/70 truncate ${mono ? "font-mono" : ""}`}>{value}</span>
    </>
  );
}

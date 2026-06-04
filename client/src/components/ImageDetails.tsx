import type { GeneratedImage, ImageGenerationParams } from "../types";
import { MarkdownRenderer } from "./ui/MarkdownRenderer";

interface Props {
  image: GeneratedImage;
  onUseParams: (params: Partial<ImageGenerationParams>) => void;
  onOpenLightbox?: (image: GeneratedImage) => void;
}

export function ImageDetails({ image, onUseParams, onOpenLightbox }: Props) {
  const p = image.params;
  const isAnalyzed = image.type === "analyzed";

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
    a.download = `porrima-${image.resolvedSeed || image.id}.jxl`;
    a.click();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto space-y-4 min-h-0">
        {/* Description (analyzed images) or Prompt (generated images) */}
        <div className="space-y-2">
          {isAnalyzed && image.description ? (
            <>
              <label className="text-[10px] font-medium text-white/40 uppercase tracking-wider">Description</label>
              <div className="text-xs text-white/70 leading-relaxed markdown-body">
                <MarkdownRenderer content={image.description} />
              </div>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>

        {/* Params — only meaningful for generated images */}
        {!isAnalyzed && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <Param label="Model" value={p.model} />
            <Param label="Seed" value={image.resolvedSeed?.toString() ?? "—"} mono />
            <Param label="Steps" value={p.steps?.toString() ?? "—"} />
            <Param label="CFG" value={p.cfgScale?.toFixed(1) ?? "—"} />
            <Param label="Size" value={`${p.width}x${p.height}`} />
            <Param label="Sampler" value={p.sampler || "euler"} />
            <Param label="Scheduler" value={p.scheduler || "normal"} />
          </div>
        )}

        {isAnalyzed && (
          <div className="text-[10px] font-medium text-purple-300/60 uppercase tracking-wider">
            Analyzed image
          </div>
        )}
      </div>

      {/* Fixed action buttons */}
      <div className="shrink-0 space-y-2 pt-3 border-t border-white/10 mt-3">
        {!isAnalyzed && (
          <button
            onClick={handleUseParams}
            className="w-full px-3 py-2 rounded-lg text-xs font-medium bg-amber-500/15 border border-amber-400/20 text-amber-300 hover:bg-amber-500/25 transition-all pressable"
          >
            Use as starting point
          </button>
        )}
        <button
          onClick={handleDownload}
          className="w-full px-3 py-2 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/60 hover:text-white/80 hover:bg-white/10 transition-all pressable"
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

import type { GeneratedImage } from "../types";

interface Props {
  image: GeneratedImage;
}

export function GeneratedImagePanel({ image }: Props) {
  const p = image.params;

  return (
    <div className="mt-3 rounded-xl border border-white/10 overflow-hidden bg-black/20">
      <div className="px-3 py-2 border-b border-white/10 bg-white/[0.03] flex justify-between items-center">
        <span className="text-xs text-white/70">Generated Image</span>
        <span className="text-[10px] text-white/40">
          {p.model} | {p.steps} steps | seed: {image.resolvedSeed}
        </span>
      </div>
      <img
        src={image.url}
        alt={p.positivePrompt.slice(0, 80)}
        loading="lazy"
        decoding="async"
        className="w-full max-h-[500px] object-contain"
      />
    </div>
  );
}

import { useState, useCallback } from "react";
import { useImageSandbox } from "../hooks/useImageSandbox";
import { ImageControls } from "./ImageControls";
import { ImageGallery } from "./ImageGallery";
import { ImageDetails } from "./ImageDetails";
import type { ImageGenerationParams } from "../types";

interface Props {
  onClose: () => void;
}

export function ImageSandbox({ onClose }: Props) {
  const {
    images,
    selectedImage,
    setSelectedImage,
    generating,
    progress,
    comfyuiStatus,
    models,
    error,
    generate,
    abort,
  } = useImageSandbox();

  const [controlParams, setControlParams] = useState<Partial<ImageGenerationParams> | undefined>();

  const handleUseParams = useCallback((params: Partial<ImageGenerationParams>) => {
    setControlParams({ ...params });
  }, []);

  const isAvailable = comfyuiStatus?.available ?? false;

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-white/10 flex items-center justify-between backdrop-blur-xl bg-white/[0.03]">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-white/90">Image Sandbox</h2>
          <div className="flex items-center gap-1.5">
            <div
              className={`w-2 h-2 rounded-full ${
                isAvailable ? "bg-green-400" : "bg-red-400"
              }`}
            />
            <span className="text-xs text-white/40">
              {comfyuiStatus === null
                ? "Checking..."
                : isAvailable
                ? "ComfyUI Connected"
                : "ComfyUI Unavailable"}
            </span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-white/40 hover:text-white/70 transition-colors p-1.5 rounded-lg hover:bg-white/5"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18" />
            <path d="M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="shrink-0 px-4 py-2 bg-red-500/10 border-b border-red-400/20 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Main layout */}
      <div className="flex-1 flex min-h-0">
        {/* Controls panel */}
        <div className="w-80 shrink-0 border-r border-white/10 overflow-y-auto p-4 backdrop-blur-xl bg-white/[0.03]">
          <ImageControls
            models={models}
            generating={generating}
            progress={progress}
            onGenerate={generate}
            onAbort={abort}
            initialParams={controlParams}
          />
        </div>

        {/* Gallery / Preview */}
        <div className="flex-1 flex flex-col min-w-0">
          <ImageGallery
            images={images}
            selectedImage={selectedImage}
            onSelect={setSelectedImage}
          />
        </div>

        {/* Details panel (conditional) */}
        {selectedImage && (
          <div className="w-80 shrink-0 border-l border-white/10 overflow-y-auto p-4 backdrop-blur-xl bg-white/[0.03]">
            <ImageDetails
              image={selectedImage}
              onUseParams={handleUseParams}
            />
          </div>
        )}
      </div>
    </div>
  );
}

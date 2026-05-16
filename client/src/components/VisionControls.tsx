import { useState, useCallback, useRef, useEffect } from "react";
import type { VisionPreset, AnalyzedImage } from "../api/client";
import type { OllamaModel } from "../types";
import { ProviderIcon } from "./ProviderIcon";
import { Dropdown } from "./ui/Dropdown";
import { useDropdown } from "../hooks/useDropdown";

const MAX_DIMENSION = 2048;
const TARGET_BYTES = 2 * 1024 * 1024; // 2 MB

function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;

      // Downscale if either dimension exceeds the cap
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        const scale = MAX_DIMENSION / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, width, height);

      // Try WebP at decreasing quality until under target size
      let quality = 0.85;
      let dataUrl = canvas.toDataURL("image/webp", quality);

      while (dataUrl.length * 0.75 > TARGET_BYTES && quality > 0.3) {
        quality -= 0.1;
        dataUrl = canvas.toDataURL("image/webp", quality);
      }

      resolve(dataUrl);
    };
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = URL.createObjectURL(file);
  });
}

interface Props {
  presets: VisionPreset[];
  models: OllamaModel[];
  selectedModel: string;
  onModelChange: (modelId: string) => void;
  analyzing: boolean;
  streamingDescription: string | null;
  onAnalyze: (imageData: string, preset: string) => Promise<void>;
  analyzedImages: AnalyzedImage[];
  selectedImage: AnalyzedImage | null;
  onSelectImage: (id: string) => void;
  onDeleteImage?: (id: string) => void;
  selectedPreset: string;
  setSelectedPreset: (preset: string) => void;
}

export function VisionControls({
  presets,
  models,
  selectedModel,
  onModelChange,
  analyzing,
  streamingDescription,
  onAnalyze,
  analyzedImages,
  selectedImage,
  onSelectImage,
  onDeleteImage,
  selectedPreset,
  setSelectedPreset,
}: Props) {
  const modelDd = useDropdown();
  const presetDd = useDropdown();
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedModelObj = models.find((m) => m.id === selectedModel);
  const selectedPresetObj = presets.find((p) => p.key === selectedPreset);

  const handleFileSelect = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    try {
      const imageData = await compressImage(file);
      await onAnalyze(imageData, selectedPreset);
    } catch (error) {
      console.error("Analysis failed:", error);
    }
  }, [onAnalyze, selectedPreset]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  }, [handleFileSelect]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
    e.target.value = "";
  }, [handleFileSelect]);

  return (
    <div className="flex flex-col h-full">
      {/* Controls */}
      <div className="shrink-0 space-y-3 p-4 border-b border-white/10">
        {/* Model */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-white/50">Model</label>
          <Dropdown
            state={modelDd}
            disabled={analyzing}
            panelClassName="left-0 right-0 top-full mt-1 max-h-[320px] overflow-y-auto"
            trigger={<span className="truncate flex-1 text-left">{selectedModelObj?.name || selectedModel}</span>}
          >
            {models.map((m) => (
              <button
                key={m.id}
                onClick={() => { onModelChange(m.id); modelDd.close(); }}
                className={`w-full text-left px-3 py-2 text-xs transition-all flex items-center gap-2 ${
                  m.id === selectedModel
                    ? "text-white"
                    : "text-white/60 hover:bg-white/10 hover:text-white/80"
                }`}
                style={{
                  backgroundColor: m.id === selectedModel ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                  color: m.id === selectedModel ? `rgba(var(--theme-secondary-text))` : '',
                }}
              >
                <span className="truncate flex-1">{m.name}</span>
                <span className="text-[10px] text-white/30 shrink-0">{m.parameterSize}</span>
                <ProviderIcon
                  provider={m.provider}
                  className={m.provider === "llamacpp" ? "text-[#ff8236] shrink-0" : "text-white/40 shrink-0"}
                />
              </button>
            ))}
          </Dropdown>
        </div>

        {/* Preset */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-white/50">Description Style</label>
          <Dropdown
            state={presetDd}
            disabled={analyzing}
            panelClassName="left-0 right-0 top-full mt-1 max-h-[320px] overflow-y-auto"
            trigger={<span className="truncate flex-1 text-left">{selectedPresetObj?.name || selectedPreset}</span>}
          >
            {presets.map((p) => (
              <button
                key={p.key}
                onClick={() => { setSelectedPreset(p.key); presetDd.close(); }}
                className={`w-full text-left px-3 py-2 text-xs transition-all ${
                  p.key === selectedPreset
                    ? "text-white"
                    : "text-white/60 hover:bg-white/10 hover:text-white/80"
                }`}
                style={{
                  backgroundColor: p.key === selectedPreset ? `rgba(var(--theme-primary), 0.15)` : 'transparent',
                  color: p.key === selectedPreset ? `rgba(var(--theme-primary-text))` : '',
                }}
              >
                {p.name}
              </button>
            ))}
          </Dropdown>
        </div>

        {/* Drop zone */}
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={handleClick}
          className={`
            relative border-2 border-dashed rounded-xl p-6 text-center cursor-pointer
            transition-colors duration-200
            ${dragOver
              ? "border-white/40 bg-white/10"
              : "border-white/10 hover:border-white/20 hover:bg-white/5"
            }
            ${analyzing ? "opacity-50 pointer-events-none" : ""}
          `}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleInputChange}
            className="hidden"
            disabled={analyzing}
          />
          <div className="space-y-1">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mx-auto text-white/40"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
            </svg>
            {analyzing ? (
              <div className="flex items-center justify-center gap-2 text-sm text-white/60">
                <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
                <span>{streamingDescription !== null ? "Analyzing..." : "Saving..."}</span>
              </div>
            ) : (
              <>
                <p className="text-sm text-white/80 font-medium">Drop an image here</p>
                <p className="text-xs text-white/40">or click to browse</p>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto pr-[6px]">
        {analyzedImages.length === 0 ? (
          <div className="p-4 text-center text-xs text-white/30">
            No analyzed images yet
          </div>
        ) : (
          <div className="py-1">
            {analyzedImages.map((image) => (
              <button
                key={image.id}
                onClick={() => onSelectImage(image.id)}
                className={`
                  w-full text-left flex items-center gap-3 px-3 py-2.5 ml-1 mr-2 rounded-xl transition-all group border
                  ${selectedImage?.id === image.id
                    ? ""
                    : "border-transparent hover:bg-white/5"
                  }
                `}
                style={{
                  borderColor: selectedImage?.id === image.id ? `rgba(var(--theme-secondary-border))` : '',
                  backgroundColor: selectedImage?.id === image.id ? `rgba(var(--theme-secondary), 0.15)` : '',
                }}
              >
                {/* Thumbnail */}
                <img
                  src={`/api/vision/images/${image.id}/thumb`}
                  alt=""
                  className="w-10 h-10 rounded object-cover shrink-0"
                  loading="lazy"
                />
                {/* Preview */}
                <div className="flex-1 min-w-0">
                  <p className={`text-xs truncate ${
                    selectedImage?.id === image.id ? "text-white" : "text-white/70"
                  }`}
                    style={{
                      color: selectedImage?.id === image.id ? `rgba(var(--theme-secondary-text))` : '',
                    }}
                  >
                    {image.description.slice(0, 80).replace(/\n/g, " ")}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-white/30">{image.preset}</span>
                    <span className="text-[10px] text-white/20">{image.model?.split(":")[0]}</span>
                  </div>
                </div>
                {/* Delete */}
                {onDeleteImage && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteImage(image.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-400 transition-all p-1 shrink-0"
                    title="Delete"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6L6 18" />
                      <path d="M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

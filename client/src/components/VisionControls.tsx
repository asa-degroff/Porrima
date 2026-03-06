import { useState, useCallback, useRef, useEffect } from "react";
import type { VisionPreset, AnalyzedImage } from "../api/client";
import type { OllamaModel } from "../types";

const chevronSvg = (open: boolean) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="10"
    height="10"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

function useClickOutside(ref: React.RefObject<HTMLDivElement | null>, onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [active, ref, onClose]);
}

interface Props {
  presets: VisionPreset[];
  models: OllamaModel[];
  selectedModel: string;
  onModelChange: (modelId: string) => void;
  analyzing: boolean;
  onAnalyze: (imageData: string, preset: string) => Promise<void>;
  analyzedImages: AnalyzedImage[];
  selectedImage: AnalyzedImage | null;
  onSelectImage: (id: string) => void;
  onDeleteImage?: (id: string) => void;
}

export function VisionControls({
  presets,
  models,
  selectedModel,
  onModelChange,
  analyzing,
  onAnalyze,
  analyzedImages,
  selectedImage,
  onSelectImage,
  onDeleteImage,
}: Props) {
  const [selectedPreset, setSelectedPreset] = useState<string>("detailed");
  const [modelOpen, setModelOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const presetRef = useRef<HTMLDivElement>(null);

  useClickOutside(modelRef, () => setModelOpen(false), modelOpen);
  useClickOutside(presetRef, () => setPresetOpen(false), presetOpen);

  const selectedModelObj = models.find((m) => m.id === selectedModel);
  const selectedPresetObj = presets.find((p) => p.key === selectedPreset);

  const handleFileSelect = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      const imageData = e.target?.result as string;
      try {
        await onAnalyze(imageData, selectedPreset);
      } catch (error) {
        console.error("Analysis failed:", error);
      }
    };
    reader.readAsDataURL(file);
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
          <div className="relative" ref={modelRef}>
            <button
              onClick={() => !analyzing && setModelOpen((o) => !o)}
              disabled={analyzing}
              className="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none hover:bg-white/10 transition-all disabled:opacity-40 cursor-pointer"
            >
              <span className="truncate flex-1 text-left">{selectedModelObj?.name || selectedModel}</span>
              {chevronSvg(modelOpen)}
            </button>
            {modelOpen && (
              <div className="absolute left-0 right-0 top-full mt-1 z-30 max-h-[320px] overflow-y-auto backdrop-blur-xl bg-[#1a1a2e]/95 border border-white/15 rounded-xl shadow-2xl py-1">
                {models.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => { onModelChange(m.id); setModelOpen(false); }}
                    className={`w-full text-left px-3 py-2 text-xs transition-all flex items-center gap-2 ${
                      m.id === selectedModel
                        ? "bg-blue-500/15 text-blue-200"
                        : "text-white/60 hover:bg-white/10 hover:text-white/80"
                    }`}
                  >
                    <span className="truncate flex-1">{m.name}</span>
                    <span className="text-[10px] text-white/30 shrink-0">{m.parameterSize}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Preset */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-white/50">Description Style</label>
          <div className="relative" ref={presetRef}>
            <button
              onClick={() => !analyzing && setPresetOpen((o) => !o)}
              disabled={analyzing}
              className="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none hover:bg-white/10 transition-all disabled:opacity-40 cursor-pointer"
            >
              <span className="truncate flex-1 text-left">{selectedPresetObj?.name || selectedPreset}</span>
              {chevronSvg(presetOpen)}
            </button>
            {presetOpen && (
              <div className="absolute left-0 right-0 top-full mt-1 z-30 max-h-[320px] overflow-y-auto backdrop-blur-xl bg-[#1a1a2e]/95 border border-white/15 rounded-xl shadow-2xl py-1">
                {presets.map((p) => (
                  <button
                    key={p.key}
                    onClick={() => { setSelectedPreset(p.key); setPresetOpen(false); }}
                    className={`w-full text-left px-3 py-2 text-xs transition-all ${
                      p.key === selectedPreset
                        ? "bg-blue-500/15 text-blue-200"
                        : "text-white/60 hover:bg-white/10 hover:text-white/80"
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
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
                <span>Analyzing...</span>
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
      <div className="flex-1 overflow-y-auto">
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
                  w-full text-left flex items-center gap-3 px-4 py-2.5 transition-all group
                  ${selectedImage?.id === image.id
                    ? "bg-blue-500/15 border-l-2 border-blue-400"
                    : "hover:bg-white/5 border-l-2 border-transparent"
                  }
                `}
              >
                {/* Thumbnail */}
                <img
                  src={image.url}
                  alt=""
                  className="w-10 h-10 rounded object-cover shrink-0"
                  loading="lazy"
                />
                {/* Preview */}
                <div className="flex-1 min-w-0">
                  <p className={`text-xs truncate ${
                    selectedImage?.id === image.id ? "text-blue-200" : "text-white/70"
                  }`}>
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

import { useState, useCallback, useRef, useEffect } from "react";
import type { VisionPreset } from "../api/client";
import type { OllamaModel } from "../types";

interface Props {
  presets: VisionPreset[];
  models: OllamaModel[];
  selectedModel: string;
  onModelChange: (modelId: string) => void;
  analyzing: boolean;
  onAnalyze: (imageData: string, preset: string) => Promise<void>;
}

export function VisionControls({ presets, models, selectedModel, onModelChange, analyzing, onAnalyze }: Props) {
  const [selectedPreset, setSelectedPreset] = useState<string>("detailed");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      alert("Please select an image file");
      return;
    }

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
    if (file) {
      handleFileSelect(file);
    }
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
    if (file) {
      handleFileSelect(file);
    }
    // Reset input so same file can be selected again
    e.target.value = "";
  }, [handleFileSelect]);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-white/70 mb-2">Model</h3>
        <select
          value={selectedModel}
          onChange={(e) => onModelChange(e.target.value)}
          disabled={analyzing}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/90 focus:outline-none focus:ring-2 focus:ring-white/20 disabled:opacity-50"
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <h3 className="text-sm font-medium text-white/70 mb-2">Description Style</h3>
        <select
          value={selectedPreset}
          onChange={(e) => setSelectedPreset(e.target.value)}
          disabled={analyzing}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/90 focus:outline-none focus:ring-2 focus:ring-white/20 disabled:opacity-50"
        >
          {presets.map((preset) => (
            <option key={preset.key} value={preset.key}>
              {preset.name}
            </option>
          ))}
        </select>
      </div>

      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={handleClick}
        className={`
          relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer
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
        
        <div className="space-y-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="32"
            height="32"
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
          
          <div className="text-sm text-white/60">
            {analyzing ? (
              <span>Analyzing...</span>
            ) : (
              <>
                <p className="text-white/80 font-medium">Drop an image here</p>
                <p className="text-xs">or click to browse</p>
              </>
            )}
          </div>
        </div>
      </div>

      {analyzing && (
        <div className="flex items-center gap-2 text-sm text-white/60">
          <div className="w-4 h-4 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
          <span>Analyzing image...</span>
        </div>
      )}
    </div>
  );
}

import { useState, useCallback } from "react";
import { useImageSandbox } from "../hooks/useImageSandbox";
import { useVisionSandbox } from "../hooks/useVisionSandbox";
import { ImageControls } from "./ImageControls";
import { ImageGallery } from "./ImageGallery";
import { ImageDetails } from "./ImageDetails";
import { VisionControls } from "./VisionControls";
import { VisionGallery } from "./VisionGallery";
import { VisionChat } from "./VisionChat";
import type { ImageGenerationParams, OllamaModel } from "../types";
import type { AnalyzedImage } from "../api/client";

interface Props {
  models: OllamaModel[];
  defaultModelId: string;
  onClose: () => void;
}

type SandboxMode = "generate" | "analyze";
type ViewMode = "gallery" | "chat";

export function ImageSandbox({ models: ollamaModels, defaultModelId, onClose }: Props) {
  const {
    images,
    selectedImage,
    setSelectedImage,
    generating,
    progress,
    comfyuiStatus,
    models,
    error: imageError,
    generate,
    abort,
  } = useImageSandbox();

  const {
    presets,
    analyzedImages,
    selectedImage: selectedAnalyzedImage,
    analyzing,
    chatting,
    error: visionError,
    analyzeImage,
    chatAboutImage,
    reanalyzeImage,
    deleteImage,
    selectImage,
    setSelectedImage: setSelectedAnalyzedImage,
  } = useVisionSandbox();

  const [mode, setMode] = useState<SandboxMode>("analyze");
  const [viewMode, setViewMode] = useState<ViewMode>("gallery");
  const [controlParams, setControlParams] = useState<Partial<ImageGenerationParams> | undefined>();
  const [visionModel, setVisionModel] = useState<string>(() => {
    // Prefer the default model if it's vision-capable, otherwise find a vision model
    const defaultModel = ollamaModels.find((m) => m.id === defaultModelId);
    if (defaultModel && defaultModel.family.includes("vl")) return defaultModelId;
    const visionDefault = ollamaModels.find((m) => m.family.includes("vl"));
    return visionDefault?.id || defaultModelId;
  });

  const error = mode === "generate" ? imageError : visionError;

  const isAvailable = mode === "generate" 
    ? (comfyuiStatus?.available ?? false)
    : true; // Vision is always "available" if Ollama is running

  const handleUseParams = useCallback((params: Partial<ImageGenerationParams>) => {
    setControlParams({ ...params });
  }, []);

  const handleAnalyze = useCallback(async (imageData: string, preset: string) => {
    await analyzeImage(imageData, preset, visionModel);
    setViewMode("chat");
  }, [analyzeImage, visionModel]);

  const handleChat = useCallback(async (message: string) => {
    if (!selectedAnalyzedImage) throw new Error("No image selected");
    return chatAboutImage(selectedAnalyzedImage.id, message);
  }, [selectedAnalyzedImage, chatAboutImage]);

  const handleReanalyze = useCallback(async (preset: string) => {
    if (!selectedAnalyzedImage) throw new Error("No image selected");
    await reanalyzeImage(selectedAnalyzedImage.id, preset);
  }, [selectedAnalyzedImage, reanalyzeImage]);

  const handleSelectAnalyzedImage = useCallback(async (id: string) => {
    await selectImage(id);
    setViewMode("chat");
  }, [selectImage]);

  const handleCloseChat = useCallback(() => {
    setViewMode("gallery");
    setSelectedAnalyzedImage(null);
  }, [setSelectedAnalyzedImage]);

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-white/10 flex items-center justify-between backdrop-blur-xl bg-white/[0.03]">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-white/90">Image Sandbox</h2>
          
          {/* Mode switcher */}
          <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1">
            <button
              onClick={() => setMode("analyze")}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                mode === "analyze"
                  ? "bg-white/10 text-white/90"
                  : "text-white/50 hover:text-white/70"
              }`}
            >
              Analyze
            </button>
            <button
              onClick={() => setMode("generate")}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                mode === "generate"
                  ? "bg-white/10 text-white/90"
                  : "text-white/50 hover:text-white/70"
              }`}
            >
              Generate
            </button>
          </div>

          {/* Status indicator */}
          <div className="flex items-center gap-1.5">
            <div
              className={`w-2 h-2 rounded-full ${
                isAvailable ? "bg-green-400" : "bg-red-400"
              }`}
            />
            <span className="text-xs text-white/40">
              {mode === "generate"
                ? comfyuiStatus === null
                  ? "Checking..."
                  : isAvailable
                  ? "ComfyUI Connected"
                  : "ComfyUI Unavailable"
                : "Vision Ready"
              }
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {mode === "analyze" && selectedAnalyzedImage && (
            <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1">
              <button
                onClick={() => setViewMode("gallery")}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${
                  viewMode === "gallery"
                    ? "bg-white/10 text-white/90"
                    : "text-white/50 hover:text-white/70"
                }`}
              >
                Gallery
              </button>
              <button
                onClick={() => setViewMode("chat")}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${
                  viewMode === "chat"
                    ? "bg-white/10 text-white/90"
                    : "text-white/50 hover:text-white/70"
                }`}
              >
                Chat
              </button>
            </div>
          )}
          
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
      </div>

      {/* Error banner */}
      {error && (
        <div className="shrink-0 px-4 py-2 bg-red-500/10 border-b border-red-400/20 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Main layout */}
      <div className="flex-1 flex min-h-0">
        {mode === "generate" ? (
          <>
            {/* Generation Controls panel */}
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
          </>
        ) : (
          <>
            {/* Vision mode */}
            {viewMode === "gallery" ? (
              <>
                {/* Vision Controls panel */}
                <div className="w-80 shrink-0 border-r border-white/10 overflow-y-auto p-4 backdrop-blur-xl bg-white/[0.03]">
                  <VisionControls
                    presets={presets}
                    models={ollamaModels}
                    selectedModel={visionModel}
                    onModelChange={setVisionModel}
                    analyzing={analyzing}
                    onAnalyze={handleAnalyze}
                  />
                </div>

                {/* Gallery */}
                <div className="flex-1 flex flex-col min-w-0">
                  <VisionGallery
                    images={analyzedImages}
                    selectedImage={selectedAnalyzedImage}
                    onSelect={handleSelectAnalyzedImage}
                    onDelete={deleteImage}
                  />
                </div>
              </>
            ) : (
              /* Chat view */
              selectedAnalyzedImage ? (
                <div className="flex-1 flex flex-col min-w-0">
                  <VisionChat
                    image={selectedAnalyzedImage}
                    chatting={chatting}
                    onChat={handleChat}
                    onReanalyze={handleReanalyze}
                    onClose={handleCloseChat}
                  />
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-white/40">
                  Select an image to chat
                </div>
              )
            )}
          </>
        )}
      </div>
    </div>
  );
}

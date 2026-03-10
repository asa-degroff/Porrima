import { useState, useCallback, useEffect } from "react";
import { useImageSandbox } from "../hooks/useImageSandbox";
import { useVisionSandbox } from "../hooks/useVisionSandbox";
import { ImageControls } from "./ImageControls";
import { ImageGallery } from "./ImageGallery";
import { ImageDetails } from "./ImageDetails";
import { VisionControls } from "./VisionControls";
import { VisionChat } from "./VisionChat";
import type { GeneratedImage, ImageGenerationParams, OllamaModel } from "../types";

interface Props {
  models: OllamaModel[];
  defaultModelId: string;
  defaultVisionModelId?: string;
  onClose: () => void;
}

type SandboxMode = "generate" | "analyze";

function isVisionCapable(family: string): boolean {
  return family.includes("vl") || family.startsWith("qwen35");
}

export function ImageSandbox({ models: ollamaModels, defaultModelId, defaultVisionModelId, onClose }: Props) {
  const {
    images,
    selectedImage,
    setSelectedImage,
    generating,
    progress,
    comfyuiStatus,
    models,
    error: imageError,
    enqueue,
    abort,
    abortAll,
    clearQueue,
    queue,
    currentItem,
  } = useImageSandbox();

  const [lightboxImage, setLightboxImage] = useState<GeneratedImage | null>(null);
  const closeLightbox = useCallback(() => setLightboxImage(null), []);

  useEffect(() => {
    if (!lightboxImage) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLightbox();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lightboxImage, closeLightbox]);

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
  const [controlParams, setControlParams] = useState<Partial<ImageGenerationParams> | undefined>();
  const [visionModel, setVisionModel] = useState<string>(() => {
    // 1. Use explicit vision model setting if set
    if (defaultVisionModelId) {
      const configured = ollamaModels.find((m) => m.id === defaultVisionModelId);
      if (configured) return defaultVisionModelId;
    }
    // 2. Use chat default if it's vision-capable
    const chatDefault = ollamaModels.find((m) => m.id === defaultModelId);
    if (chatDefault && isVisionCapable(chatDefault.family)) return defaultModelId;
    // 3. Fall back to first vision model
    const visionDefault = ollamaModels.find((m) => isVisionCapable(m.family));
    return visionDefault?.id || defaultModelId;
  });

  const error = mode === "generate" ? imageError : visionError;

  const isAvailable = mode === "generate"
    ? (comfyuiStatus?.available ?? false)
    : true;

  const handleUseParams = useCallback((params: Partial<ImageGenerationParams>) => {
    setControlParams({ ...params });
  }, []);

  const handleSendToGenerate = useCallback((description: string) => {
    setControlParams({ positivePrompt: description });
    setMode("generate");
  }, []);

  const handleAnalyze = useCallback(async (imageData: string, preset: string) => {
    await analyzeImage(imageData, preset, visionModel);
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
  }, [selectImage]);

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
        {mode === "generate" ? (
          <>
            {/* Generation Controls panel */}
            <div className="w-80 shrink-0 border-r border-white/10 overflow-y-auto p-4 backdrop-blur-xl bg-white/[0.03]">
              <ImageControls
                models={models}
                generating={generating}
                progress={progress}
                onEnqueue={enqueue}
                onAbort={abort}
                onAbortAll={abortAll}
                onClearQueue={clearQueue}
                queue={queue}
                currentItem={currentItem}
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
                  onOpenLightbox={setLightboxImage}
                />
              </div>
            )}

            {/* Lightbox */}
            {lightboxImage && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
                onClick={closeLightbox}
              >
                <button
                  onClick={closeLightbox}
                  className="absolute top-4 right-4 p-2 rounded-lg text-white/50 hover:text-white/90 hover:bg-white/10 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6L6 18" />
                    <path d="M6 6l12 12" />
                  </svg>
                </button>
                <img
                  src={lightboxImage.url}
                  alt={lightboxImage.params.positivePrompt.slice(0, 50)}
                  className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-black/60 text-xs text-white/60 font-mono">
                  {lightboxImage.params.width}x{lightboxImage.params.height} &middot; seed: {lightboxImage.resolvedSeed} &middot; {lightboxImage.params.model}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {/* Left panel: controls + conversation list */}
            <div className="w-80 shrink-0 border-r border-white/10 backdrop-blur-xl bg-white/[0.03]">
              <VisionControls
                presets={presets}
                models={ollamaModels}
                selectedModel={visionModel}
                onModelChange={setVisionModel}
                analyzing={analyzing}
                onAnalyze={handleAnalyze}
                analyzedImages={analyzedImages}
                selectedImage={selectedAnalyzedImage}
                onSelectImage={handleSelectAnalyzedImage}
                onDeleteImage={deleteImage}
              />
            </div>

            {/* Right panel: image + description/chat */}
            <div className="flex-1 flex flex-col min-w-0">
              {selectedAnalyzedImage ? (
                <VisionChat
                  image={selectedAnalyzedImage}
                  chatting={chatting}
                  onChat={handleChat}
                  onReanalyze={handleReanalyze}
                  onSendToGenerate={handleSendToGenerate}
                />
              ) : (
                <div className="flex-1 flex items-center justify-center text-white/30">
                  <div className="text-center space-y-2">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="48"
                      height="48"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="mx-auto opacity-50"
                    >
                      <rect width="18" height="18" x="3" y="3" rx="2" />
                      <circle cx="9" cy="9" r="2" />
                      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                    </svg>
                    <p className="text-sm">Upload an image to get started</p>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

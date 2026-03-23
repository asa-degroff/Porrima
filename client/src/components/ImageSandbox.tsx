import { useState, useCallback, useEffect, useMemo } from "react";
import { useImageSandbox } from "../hooks/useImageSandbox";
import { useVisionSandbox } from "../hooks/useVisionSandbox";
import { ImageControls } from "./ImageControls";
import { ImageGallery } from "./ImageGallery";
import { ImageDetails } from "./ImageDetails";
import { ImageCarousel } from "./ImageCarousel";
import { ProgressiveImage } from "./ProgressiveImage";
import { VisionControls } from "./VisionControls";
import { VisionChat } from "./VisionChat";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { OctahedronLogo } from "./OctahedronLogo";
import { useCachedImage } from "../utils/imageCache";
import CorpusView from "./CorpusView";
import type { GeneratedImage, ImageGenerationParams, OllamaModel } from "../types";

interface Props {
  models: OllamaModel[];
  defaultModelId: string;
  defaultVisionModelId?: string;
  onClose: () => void;
}

type SandboxMode = "generate" | "analyze" | "corpus";
type ViewMode = "gallery" | "detail";

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
    deleteImage: deleteGeneratedImage,
    activeGenerations,
  } = useImageSandbox();

  const [lightboxImage, setLightboxImage] = useState<GeneratedImage | null>(null);
  const closeLightbox = useCallback(() => setLightboxImage(null), []);
  const lightboxCachedUrl = useCachedImage(lightboxImage?.id ?? "", lightboxImage?.url ?? "");

  // View mode: gallery (grid) or detail (large image + carousel)
  const [viewMode, setViewMode] = useState<ViewMode>('gallery');

  // Navigation index for selected image in the detail pane
  const selectedIndex = useMemo(
    () => (selectedImage ? images.findIndex((img) => img.url === selectedImage.url) : -1),
    [images, selectedImage]
  );
  const hasPrevImage = selectedIndex > 0;
  const hasNextImage = selectedIndex >= 0 && selectedIndex < images.length - 1;

  const navigateImage = useCallback((dir: -1 | 1) => {
    const idx = selectedImage ? images.findIndex((img) => img.url === selectedImage.url) : -1;
    const next = idx + dir;
    if (next >= 0 && next < images.length) {
      const target = images[next];
      setSelectedImage(target);
      if (lightboxImage) setLightboxImage(target);
    }
  }, [images, selectedImage, lightboxImage, setSelectedImage]);

  // Keyboard: Escape closes lightbox or exits detail mode, arrows navigate (detail pane or lightbox)
  // Skip when focus is in a text input to avoid breaking cursor movement
  useEffect(() => {
    if (!selectedImage && !lightboxImage) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (lightboxImage) { closeLightbox(); return; }
        if (viewMode === 'detail') { setViewMode('gallery'); return; }
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); navigateImage(-1); }
      if (e.key === "ArrowRight") { e.preventDefault(); navigateImage(1); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedImage, lightboxImage, viewMode, closeLightbox, navigateImage]);

  const {
    presets,
    analyzedImages,
    selectedImage: selectedAnalyzedImage,
    analyzing,
    chatting,
    streamingDescription,
    pendingImageData,
    error: visionError,
    selectedPreset,
    analyzeImage,
    chatAboutImage,
    reanalyzeImage,
    deleteImage,
    selectImage,
    setSelectedImage: setSelectedAnalyzedImage,
    setSelectedPreset,
  } = useVisionSandbox();

  const [mode, setMode] = useState<SandboxMode>(() => {
    try {
      const saved = localStorage.getItem("quje-sandbox-mode");
      if (saved === "generate" || saved === "analyze") return saved;
    } catch {}
    return "analyze";
  });
  const [controlParams, setControlParams] = useState<Partial<ImageGenerationParams> | undefined>();

  // Persist mode to localStorage
  useEffect(() => {
    try {
      localStorage.setItem("quje-sandbox-mode", mode);
    } catch {}
  }, [mode]);

  // Close drawers when switching modes
  useEffect(() => {
    setControlsOpen(false);
    setDetailsOpen(false);
  }, [mode]);

  const [visionModel, setVisionModelRaw] = useState<string>(() => {
    // 1. Check localStorage for a previously selected vision model
    try {
      const saved = localStorage.getItem("quje-vision-model");
      if (saved && ollamaModels.some((m) => m.id === saved)) return saved;
    } catch {}
    // 2. Use explicit vision model setting if set
    if (defaultVisionModelId) {
      const configured = ollamaModels.find((m) => m.id === defaultVisionModelId);
      if (configured) return defaultVisionModelId;
    }
    // 3. Use chat default if it's vision-capable
    const chatDefault = ollamaModels.find((m) => m.id === defaultModelId);
    if (chatDefault && isVisionCapable(chatDefault.family)) return defaultModelId;
    // 4. Fall back to first vision model
    const visionDefault = ollamaModels.find((m) => isVisionCapable(m.family));
    return visionDefault?.id || defaultModelId;
  });

  const setVisionModel = useCallback((id: string) => {
    setVisionModelRaw(id);
    try { localStorage.setItem("quje-vision-model", id); } catch {}
  }, []);

  // Re-validate selection when models list arrives/changes
  useEffect(() => {
    if (ollamaModels.length === 0) return;
    // Current selection is valid — keep it
    if (ollamaModels.some((m) => m.id === visionModel)) return;
    // Try localStorage
    try {
      const saved = localStorage.getItem("quje-vision-model");
      if (saved && ollamaModels.some((m) => m.id === saved)) {
        setVisionModelRaw(saved);
        return;
      }
    } catch {}
    // Fall back to best vision model
    const visionDefault = ollamaModels.find((m) => isVisionCapable(m.family));
    setVisionModelRaw(visionDefault?.id || ollamaModels[0].id);
  }, [ollamaModels]);

  const error = mode === "generate" ? imageError : visionError;

  const isAvailable = mode === "generate"
    ? (comfyuiStatus?.available ?? false) || activeGenerations.length > 0
    : true;

  const handleUseParams = useCallback((params: Partial<ImageGenerationParams>) => {
    setControlParams({ ...params });
  }, []);

  const handleSendToGenerate = useCallback((description: string) => {
    setControlParams({ positivePrompt: description });
    setMode("generate");
    try {
      localStorage.setItem("quje-sandbox-mode", "generate");
    } catch {}
  }, []);

  // Persist mode on change
  useEffect(() => {
    try {
      localStorage.setItem("quje-sandbox-mode", mode);
    } catch {}
  }, [mode]);

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

  // Drawer state for mobile
  const [controlsOpen, setControlsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-white/10 flex items-center justify-between backdrop-blur-xl bg-white/[0.03]">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-white/90">Image Sandbox</h2>

          {/* Mode switcher - hidden on mobile, shown desktop */}
          <div className="hidden md:flex items-center gap-1 bg-white/5 rounded-lg p-1">
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
            <button
              onClick={() => setMode("corpus")}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                mode === "corpus"
                  ? "bg-white/10 text-white/90"
                  : "text-white/50 hover:text-white/70"
              }`}
            >
              Corpus
            </button>
          </div>

          {/* Status indicator - hidden on mobile, shown desktop */}
          <div className="hidden lg:flex items-center gap-1.5">
            <div
              className={`w-2 h-2 rounded-full ${
                isAvailable ? "bg-green-400" : "bg-red-400"
              }`}
            />
            <span className="text-xs text-white/40">
              {mode === "generate"
                ? comfyuiStatus === null
                  ? "Checking..."
                  : activeGenerations.length > 0
                    ? `${activeGenerations.length} generating`
                    : isAvailable
                      ? "ComfyUI Connected"
                      : "ComfyUI Unavailable"
                : "Vision Ready"
              }
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Mobile drawer toggles */}
          <div className="flex md:hidden items-center gap-1">
            {mode === "generate" ? (
              <>
                <button
                  onClick={() => setControlsOpen(true)}
                  className="text-white/40 hover:text-white/70 transition-colors p-1.5 rounded-lg hover:bg-white/5"
                  title="Generation controls"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" />
                    <path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
                    <path d="M12 2v2" />
                    <path d="M12 22v-2" />
                    <path d="m17 20.66-1-1" />
                    <path d="M11 10a2 2 0 0 0-1-1.73V10" />
                    <path d="M7 12a2 2 0 0 0 1-1.73V12" />
                  </svg>
                </button>
                {selectedImage && (
                  <button
                    onClick={() => setDetailsOpen(true)}
                    className="text-white/40 hover:text-white/70 transition-colors p-1.5 rounded-lg hover:bg-white/5"
                    title="Image details"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="18" height="18" x="3" y="3" rx="2" />
                      <circle cx="9" cy="9" r="2" />
                      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                    </svg>
                  </button>
                )}
              </>
            ) : (
              <button
                onClick={() => setControlsOpen(true)}
                className="text-white/40 hover:text-white/70 transition-colors p-1.5 rounded-lg hover:bg-white/5"
                title="Vision controls"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" />
                  <path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
                  <path d="M12 2v2" />
                  <path d="M12 22v-2" />
                  <path d="m17 20.66-1-1" />
                  <path d="M11 10a2 2 0 0 0-1-1.73V10" />
                  <path d="M7 12a2 2 0 0 0 1-1.73V12" />
                </svg>
              </button>
            )}
          </div>

          {/* Mobile mode switcher */}
          <div className="flex md:hidden items-center gap-1 bg-white/5 rounded-lg p-1">
            <button
              onClick={() => setMode("analyze")}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                mode === "analyze"
                  ? "bg-white/10 text-white/90"
                  : "text-white/50 hover:text-white/70"
              }`}
            >
              A
            </button>
            <button
              onClick={() => setMode("generate")}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                mode === "generate"
                  ? "bg-white/10 text-white/90"
                  : "text-white/50 hover:text-white/70"
              }`}
            >
              G
            </button>
            <button
              onClick={() => setMode("corpus")}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                mode === "corpus"
                  ? "bg-white/10 text-white/90"
                  : "text-white/50 hover:text-white/70"
              }`}
            >
              C
            </button>
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
      </div>

      {/* Error banner */}
      {error && (
        <div className="shrink-0 px-4 py-2 bg-red-500/10 border-b border-red-400/20 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Main layout */}
      <div className="flex-1 flex min-h-0 relative">
        {mode === "generate" ? (
          <>
            {/* Generation Controls - desktop sidebar */}
            <div className="hidden md:block w-80 shrink-0 border-r border-white/10 overflow-y-auto p-4 backdrop-blur-xl bg-white/[0.03]">
              <ImageControls
                models={models}
                generating={generating}
                progress={progress}
                onEnqueue={enqueue}
                onAbort={abort}
                activeGenerations={activeGenerations}
                initialParams={controlParams}
              />
            </div>

            {/* Gallery / Preview */}
            <div className="flex-1 flex flex-col min-w-0">
              {viewMode === 'gallery' ? (
                <ImageGallery
                  images={images}
                  selectedImage={selectedImage}
                  onSelect={(image) => { setSelectedImage(image); setViewMode('detail'); }}
                  onDelete={deleteGeneratedImage}
                  activeGenerations={activeGenerations}
                />
              ) : (
                /* Detail view: large image + carousel */
                <div className="flex-1 flex flex-col min-h-0 relative">
                  {/* Close button - returns to gallery */}
                  <button
                    onClick={() => setViewMode('gallery')}
                    className="absolute top-4 left-4 z-10 p-2 rounded-lg bg-black/40 text-white/60 hover:text-white/90 hover:bg-black/60 transition-all"
                    title="Back to gallery"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                  {selectedImage ? (
                    <div className="flex-1 flex items-center justify-center p-4 overflow-hidden">
                      <ProgressiveImage
                        src={selectedImage.url}
                        thumbSrc={`${selectedImage.url}/thumb`}
                        alt={selectedImage.params.positivePrompt.slice(0, 80)}
                        className="w-full h-full"
                        width={selectedImage.params.width}
                        height={selectedImage.params.height}
                        onClick={() => setLightboxImage(selectedImage)}
                      />
                    </div>
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-white/30">
                      <p className="text-sm">No image selected</p>
                    </div>
                  )}
                  <ImageCarousel
                    images={images}
                    selectedImage={selectedImage}
                    onSelect={(image) => setSelectedImage(image)}
                  />
                </div>
              )}
            </div>

            {/* Details panel - desktop sidebar */}
            {selectedImage && (
              <div className="hidden md:flex w-80 shrink-0 border-l border-white/10 p-4 backdrop-blur-xl bg-white/[0.03] flex-col">
                <ImageDetails
                  image={selectedImage}
                  onUseParams={handleUseParams}
                  onOpenLightbox={setLightboxImage}
                />
              </div>
            )}

            {/* Mobile slide-up drawer - Controls */}
            {controlsOpen && (
              <div className="md:hidden fixed inset-0 z-50 flex items-end">
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setControlsOpen(false)} />
                <div className="relative w-full max-h-[85vh] bg-[#0f0f14] border-t border-white/10 rounded-t-2xl overflow-hidden flex flex-col drawer-slide-up">
                  <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-white/10">
                    <h3 className="text-sm font-semibold text-white/90">Generation Controls</h3>
                    <button
                      onClick={() => setControlsOpen(false)}
                      className="text-white/40 hover:text-white/70 transition-colors p-1.5 rounded-lg hover:bg-white/5"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6L6 18" />
                        <path d="M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4">
                    <ImageControls
                      models={models}
                      generating={generating}
                      progress={progress}
                      onEnqueue={enqueue}
                      onAbort={abort}
                      activeGenerations={activeGenerations}
                      initialParams={controlParams}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Mobile slide-up drawer - Details */}
            {detailsOpen && selectedImage && (
              <div className="md:hidden fixed inset-0 z-50 flex items-end">
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setDetailsOpen(false)} />
                <div className="relative w-full max-h-[85vh] bg-[#0f0f14] border-t border-white/10 rounded-t-2xl overflow-hidden flex flex-col drawer-slide-up">
                  <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-white/10">
                    <h3 className="text-sm font-semibold text-white/90">Image Details</h3>
                    <button
                      onClick={() => setDetailsOpen(false)}
                      className="text-white/40 hover:text-white/70 transition-colors p-1.5 rounded-lg hover:bg-white/5"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6L6 18" />
                        <path d="M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4">
                    <ImageDetails
                      image={selectedImage}
                      onUseParams={handleUseParams}
                      onOpenLightbox={setLightboxImage}
                    />
                  </div>
                </div>
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
                  className="absolute top-4 right-4 p-2 rounded-lg text-white/50 hover:text-white/90 hover:bg-white/10 transition-colors z-10"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6L6 18" />
                    <path d="M6 6l12 12" />
                  </svg>
                </button>
                {/* Prev button */}
                <button
                  onClick={(e) => { e.stopPropagation(); navigateImage(-1); }}
                  disabled={!hasPrevImage}
                  className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/40 text-white/60 hover:text-white/90 hover:bg-black/60 transition-all disabled:opacity-20 disabled:pointer-events-none z-10"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>
                {/* Next button */}
                <button
                  onClick={(e) => { e.stopPropagation(); navigateImage(1); }}
                  disabled={!hasNextImage}
                  className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/40 text-white/60 hover:text-white/90 hover:bg-black/60 transition-all disabled:opacity-20 disabled:pointer-events-none z-10"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </button>
                <ProgressiveImage
                  src={lightboxCachedUrl}
                  thumbSrc={`${lightboxImage.url}/thumb`}
                  alt={lightboxImage.params.positivePrompt.slice(0, 50)}
                  className="max-w-[90vw] max-h-[90vh]"
                  width={lightboxImage.params.width}
                  height={lightboxImage.params.height}
                  onClick={() => {}}
                />
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-black/60 text-xs text-white/60 font-mono">
                  {lightboxImage.params.width}x{lightboxImage.params.height} &middot; seed: {lightboxImage.resolvedSeed} &middot; {lightboxImage.params.model}
                </div>
              </div>
            )}
          </>
        ) : mode === "corpus" ? (
          /* Corpus mode: force-directed graph visualization */
          <CorpusView />
        ) : (
          <>
            {/* Vision Controls - desktop sidebar */}
            <div className="hidden md:block w-80 shrink-0 border-r border-white/10 backdrop-blur-xl bg-white/[0.03]">
              <VisionControls
                presets={presets}
                models={ollamaModels}
                selectedModel={visionModel}
                onModelChange={setVisionModel}
                analyzing={analyzing}
                streamingDescription={streamingDescription}
                onAnalyze={handleAnalyze}
                analyzedImages={analyzedImages}
                selectedImage={selectedAnalyzedImage}
                onSelectImage={handleSelectAnalyzedImage}
                onDeleteImage={deleteImage}
                selectedPreset={selectedPreset}
                setSelectedPreset={setSelectedPreset}
              />
            </div>

            {/* Right panel: image + description/chat */}
            <div className="flex-1 flex flex-col min-w-0">
              {analyzing && pendingImageData ? (
                /* Streaming preview while analyzing */
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  <div className="flex flex-col items-start gap-3">
                    <img
                      src={pendingImageData}
                      alt="Analyzing..."
                      className="max-w-sm max-h-80 rounded-lg object-contain shadow-lg shadow-black/30"
                    />
                    <div className="flex items-center gap-2.5">
                      <OctahedronLogo isActive={true} count={3} size={20} gap={2} speed={0.8} />
                      <span className="text-xs text-white/40">Analyzing...</span>
                    </div>
                  </div>
                  {streamingDescription && (
                    <div className="space-y-2">
                      <label className="text-[10px] font-medium text-white/40 uppercase tracking-wider">Description</label>
                      <div className="text-sm text-white/80 leading-relaxed markdown-body">
                        <MarkdownRenderer content={streamingDescription} />
                      </div>
                    </div>
                  )}
                </div>
              ) : selectedAnalyzedImage ? (
                <VisionChat
                  image={selectedAnalyzedImage}
                  analyzing={analyzing}
                  streamingDescription={streamingDescription}
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

            {/* Mobile slide-up drawer - Vision Controls */}
            {controlsOpen && (
              <div className="md:hidden fixed inset-0 z-50 flex items-end">
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setControlsOpen(false)} />
                <div className="relative w-full max-h-[85vh] bg-[#0f0f14] border-t border-white/10 rounded-t-2xl overflow-hidden flex flex-col drawer-slide-up">
                  <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-white/10">
                    <h3 className="text-sm font-semibold text-white/90">Vision Controls</h3>
                    <button
                      onClick={() => setControlsOpen(false)}
                      className="text-white/40 hover:text-white/70 transition-colors p-1.5 rounded-lg hover:bg-white/5"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6L6 18" />
                        <path d="M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4">
                    <VisionControls
                      presets={presets}
                      models={ollamaModels}
                      selectedModel={visionModel}
                      onModelChange={setVisionModel}
                      analyzing={analyzing}
                      streamingDescription={streamingDescription}
                      onAnalyze={handleAnalyze}
                      analyzedImages={analyzedImages}
                      selectedImage={selectedAnalyzedImage}
                      onSelectImage={handleSelectAnalyzedImage}
                      onDeleteImage={deleteImage}
                      selectedPreset={selectedPreset}
                      setSelectedPreset={setSelectedPreset}
                    />
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

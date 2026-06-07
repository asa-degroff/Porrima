import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useImageSandbox } from "../hooks/useImageSandbox";
import { useVisionSandbox } from "../hooks/useVisionSandbox";
import { useSettings } from "../hooks/useSettings";
import { ImageControls } from "./ImageControls";
import { ImageGallery } from "./ImageGallery";
import { ImageDetails } from "./ImageDetails";
import { ImageCarousel } from "./ImageCarousel";
import { ProgressiveImage } from "./ProgressiveImage";
import { VisionControls } from "./VisionControls";
import { VisionChat } from "./VisionChat";
import { ThinkingBlock } from "./ThinkingBlock";
import { MarkdownRenderer } from "./ui/MarkdownRenderer";
import { PolyhedronLogo } from "./PolyhedronLogo";
import { useActivityShape } from "../hooks/useActivityStyle";
import { DragHandle } from "./ui/DragHandle";
import { ImageSearch } from "./ImageSearch";
import CorpusView from "./CorpusView";
import type { GeneratedImage, ImageGenerationParams } from "../types";
import { readStoredValue, writeStoredValue } from "../lib/storage";

interface Props {
  defaultModelId: string;
  onClose: () => void;
}

type SandboxMode = "generate" | "analyze" | "corpus" | "directions";
type ViewMode = "gallery" | "detail";
const SANDBOX_MODE_KEY = "porrima-sandbox-mode";
const LEGACY_SANDBOX_MODE_KEY = "quje-sandbox-mode";

export function ImageSandbox({ defaultModelId, onClose }: Props) {
  const activityShape = useActivityShape();
  const { settings } = useSettings();
  const backendLabel = settings.imageBackend === "sdcpp" ? "sd-server" : "ComfyUI";

  const {
    images,
    selectedImage,
    setSelectedImage,
    generating,
    progress,
    comfyuiStatus,
    coordinatorStatus,
    models,
    error: imageError,
    enqueue,
    abort,
    deleteImage: deleteGeneratedImage,
    toggleFavorite: toggleImageFavorite,
    activeGenerations,
  } = useImageSandbox();

  const [lightboxImage, setLightboxImage] = useState<GeneratedImage | null>(null);
  const closeLightbox = useCallback(() => setLightboxImage(null), []);
  const lightboxUrl = lightboxImage?.url ?? "";

  // View mode: gallery (grid) or detail (large image + carousel)
  const [viewMode, setViewMode] = useState<ViewMode>('gallery');
  
  // Filter: show favorites only
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  
  // Search
  const [searchResults, setSearchResults] = useState<Array<GeneratedImage & { score: number }> | undefined>(undefined);
  const [isSearching, setIsSearching] = useState(false);

  // Debug: log when search state changes
  useEffect(() => {
    if (searchResults !== undefined) {
      console.log("[ImageSandbox] search results updated:", searchResults.length, "items");
    }
    console.log("[ImageSandbox] search state:", { searchResults: searchResults?.length, isSearching });
  }, [searchResults, isSearching]);

  // Handler for search results
  const handleSearchResults = useCallback((results: Array<GeneratedImage & { score: number }>) => {
    console.log("[ImageSandbox] handleSearchResults called with", results.length, "items");
    setSearchResults(results);
    setIsSearching(false);
  }, []);

  const handleSearchClear = useCallback(() => {
    console.log("[ImageSandbox] handleSearchClear called");
    setSearchResults(undefined);
    setIsSearching(false);
  }, []);

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
    streamingThinking,
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
  } = useVisionSandbox(defaultModelId);

  const [mode, setMode] = useState<SandboxMode>(() => {
    try {
      const saved = readStoredValue(SANDBOX_MODE_KEY, LEGACY_SANDBOX_MODE_KEY);
      if (saved === "generate" || saved === "analyze") return saved;
    } catch {}
    return "analyze";
  });
  
  const [controlParams, setControlParams] = useState<Partial<ImageGenerationParams> | undefined>();

  // Persist mode to localStorage
  useEffect(() => {
    try {
      writeStoredValue(SANDBOX_MODE_KEY, mode, LEGACY_SANDBOX_MODE_KEY);
    } catch {}
  }, [mode]);

  // Close drawers when switching modes
  useEffect(() => {
    setControlsOpen(false);
    setDetailsOpen(false);
  }, [mode]);

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
      writeStoredValue(SANDBOX_MODE_KEY, "generate", LEGACY_SANDBOX_MODE_KEY);
    } catch {}
  }, []);

  // Persist mode on change
  useEffect(() => {
    try {
      writeStoredValue(SANDBOX_MODE_KEY, mode, LEGACY_SANDBOX_MODE_KEY);
    } catch {}
  }, [mode]);

  const handleAnalyze = useCallback(async (imageData: string, preset: string) => {
    await analyzeImage(imageData, preset);
  }, [analyzeImage]);

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

  // Gesture hooks for mobile drawers
  const controlsDrawerRef = useRef<HTMLDivElement>(null);
  const detailsDrawerRef = useRef<HTMLDivElement>(null);

  const controlsGesture = useMemo(() => ({
    isOpen: controlsOpen,
    onClose: () => setControlsOpen(false),
  }), [controlsOpen]);

  const detailsGesture = useMemo(() => ({
    isOpen: detailsOpen,
    onClose: () => setDetailsOpen(false),
  }), [detailsOpen]);

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-white/10 flex items-center justify-between backdrop-blur-xl bg-white/[0.03] h-[57px]">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <h2 className="text-lg font-semibold text-white/90">Image Sandbox</h2>

          {/* Mode switcher - hidden on mobile and iPad portrait, shown on desktop (lg+) */}
          <div className="hidden lg:flex items-center gap-1 bg-white/5 rounded-lg p-1">
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

          {/* Status indicator - hidden on mobile and iPad portrait, shown on desktop (lg+) */}
          <div className="hidden lg:flex items-center gap-1.5">
            <div
              className={`w-2 h-2 rounded-full ${
                isAvailable ? "bg-green-400" : "bg-red-400"
              }`}
            />
            <span className="text-xs text-white/40">
              {mode === "generate"
                ? coordinatorStatus
                  ? coordinatorStatus.message
                  : comfyuiStatus === null
                    ? "Checking..."
                    : activeGenerations.length > 0
                      ? `${activeGenerations.length} generating`
                      : isAvailable
                        ? `${backendLabel} Connected`
                        : `${backendLabel} Unavailable`
                : "Vision Ready"
              }
            </span>
          </div>

          {/* Desktop search bar - hidden on mobile and iPad portrait */}
          {mode === "generate" && (
            <div className="hidden lg:block w-64 lg:w-80 flex-1 max-w-md">
              <ImageSearch
                onResults={(results) => { setSearchResults(results); setIsSearching(false); }}
                onClear={() => { setSearchResults(undefined); setIsSearching(false); }}
                placeholder="Search images..."
              />
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Drawer toggles - shown on mobile and iPad portrait (lg-), hidden on desktop */}
          <div className="flex lg:hidden items-center gap-1">
            {mode === "generate" ? (
              <>
                <button
                  onClick={() => setControlsOpen(true)}
                  className="text-white/40 hover:text-white/70 transition-colors p-1.5 rounded-lg hover:bg-white/5 pressable"
                  title="Generation controls"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.532a.5.5 0 0 1 0-.962L8.5 8.936A2 2 0 0 0 9.937 7.5l1.532-6.135a.5.5 0 0 1 .963 0L13.963 7.5A2 2 0 0 0 15.4 8.936l6.135 1.532a.5.5 0 0 1 0 .962L15.4 13.963a2 2 0 0 0-1.437 1.437l-1.532 6.135a.5.5 0 0 1-.963 0z" />
                  </svg>
                </button>
                {selectedImage && (
                  <button
                    onClick={() => setDetailsOpen(true)}
                    className="text-white/40 hover:text-white/70 transition-colors p-1.5 rounded-lg hover:bg-white/5 pressable"
                    title="Image details"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <path fill-rule="evenodd" clip-rule="evenodd" d="M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2ZM5 5v14h14V5H5ZM9 7a2 2 0 110 4 2 2 0 010-4ZM5 19l3.5-4.5 3 3 4-5.5L19 15v4H5Z" />
                    </svg>
                  </button>
                )}
              </>
            ) : (
              <button
                onClick={() => setControlsOpen(true)}
                className="text-white/40 hover:text-white/70 transition-colors p-1.5 rounded-lg hover:bg-white/5 pressable"
                title="Vision controls"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            )}
          </div>

          {/* Mode switcher - shown on mobile and iPad portrait (lg-), hidden on desktop */}
          <div className="flex lg:hidden items-center gap-1 bg-white/5 rounded-lg p-1">
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
            className="text-white hover:text-white transition-colors p-1.5 rounded-lg hover:bg-white/5 pressable"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-40 hover:opacity-70 transition-opacity">
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
            {/* Generation Controls - desktop sidebar (lg+ only, iPad portrait uses slide-over) */}
            <div className="hidden lg:block w-80 shrink-0 border-r border-white/10 overflow-y-auto p-4 backdrop-blur-xl bg-white/[0.03]">
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
            <div className="flex-1 flex flex-col min-w-0 relative">
              {/* Gallery layer — always mounted, hidden behind detail view */}
              <div
                className="absolute inset-0 flex flex-col min-h-0"
                style={{ opacity: viewMode === 'gallery' ? 1 : 0, pointerEvents: viewMode === 'gallery' ? 'auto' : 'none', zIndex: viewMode === 'gallery' ? 1 : 0 }}
              >
                {/* Filter toggle + Mobile search bar */}
                <div className="shrink-0 px-4 py-2 flex flex-col gap-2 border-b border-white/10">
                  {/* Desktop (lg+): just the filter toggle and status */}
                  <div className="hidden lg:flex items-center justify-between">
                    <span className="text-xs text-white/40">
                      {searchResults !== undefined
                        ? `${searchResults.length} search result${searchResults.length !== 1 ? 's' : ''}`
                        : showFavoritesOnly ? `${images.filter(i => i.isFavorite).length} favorited` : 'Showing all generations'}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
                        className={`px-3 py-1 text-xs rounded transition-colors flex items-center gap-1.5 pressable ${
                          showFavoritesOnly
                            ? 'bg-rose-500/80 text-white'
                            : 'bg-white/10 text-white/60 hover:text-white/90'
                        }`}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill={showFavoritesOnly ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
                        </svg>
                        Favorites
                      </button>
                    </div>
                  </div>
                  {/* Mobile and iPad portrait (lg-): search bar + filter toggle */}
                  <div className="lg:hidden flex flex-col gap-2">
                    <ImageSearch
                      onResults={handleSearchResults}
                      onClear={handleSearchClear}
                      placeholder="Search images..."
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-white/40">
                        {searchResults !== undefined
                          ? `${searchResults.length} search result${searchResults.length !== 1 ? 's' : ''}`
                          : showFavoritesOnly ? `${images.filter(i => i.isFavorite).length} favorited` : 'Showing all generations'}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
                          className={`p-1.5 rounded transition-colors pressable ${
                            showFavoritesOnly
                              ? 'bg-rose-500/80 text-white'
                              : 'bg-white/10 text-white/60 hover:text-white/90'
                          }`}
                          title="Favorites"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill={showFavoritesOnly ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
                <ImageGallery
                  images={images}
                  selectedImage={selectedImage}
                  onSelect={(image) => { setSelectedImage(image as GeneratedImage); setViewMode('detail'); }}
                  onDelete={deleteGeneratedImage}
                  onToggleFavorite={toggleImageFavorite}
                  activeGenerations={activeGenerations}
                  searchResults={searchResults}
                  isSearching={isSearching}
                  showFavoritesOnly={showFavoritesOnly}
                />
              </div>

              {/* Detail layer — always mounted, hidden behind gallery */}
              <div
                className="absolute inset-0 flex flex-col min-h-0"
                style={{ opacity: viewMode === 'detail' ? 1 : 0, pointerEvents: viewMode === 'detail' ? 'auto' : 'none', zIndex: viewMode === 'detail' ? 1 : 0 }}
              >
                {/* Close button - returns to gallery */}
                <button
                  onClick={() => setViewMode('gallery')}
                  className="absolute top-4 left-4 z-10 p-2 rounded-lg bg-black/40 text-white/60 hover:text-white/90 hover:bg-black/60 transition-all pressable"
                  title="Back to gallery"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>
                {/* Favorites button */}
                {selectedImage && (
                  <button
                    onClick={() => toggleImageFavorite(selectedImage.id)}
                    className={`absolute top-4 right-4 z-10 p-2 rounded-lg backdrop-blur-sm transition-all pressable ${
                      selectedImage.isFavorite
                        ? "bg-rose-500/20 text-rose-400"
                        : "bg-black/40 text-white/60 hover:text-rose-400 hover:bg-black/60"
                    }`}
                    title={selectedImage.isFavorite ? "Remove from favorites" : "Add to favorites"}
                  >
                    <svg 
                      xmlns="http://www.w3.org/2000/svg" 
                      width="20" 
                      height="20" 
                      viewBox="0 0 24 24" 
                      fill={selectedImage.isFavorite ? "currentColor" : "none"} 
                      stroke="currentColor" 
                      strokeWidth="2" 
                      strokeLinecap="round" 
                      strokeLinejoin="round"
                    >
                      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
                    </svg>
                  </button>
                )}
                {selectedImage ? (
                  <div className="flex-1 flex items-center justify-center p-4 overflow-hidden">
                    <ProgressiveImage
                      src={selectedImage.url}
                      thumbSrc={`${selectedImage.url}/thumb`}
                      alt={selectedImage.description || selectedImage.params?.positivePrompt?.slice(0, 80) || "Image"}
                      className="w-full h-full"
                      width={selectedImage.params?.width || undefined}
                      height={selectedImage.params?.height || undefined}
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
            </div>

            {/* Details panel - desktop sidebar (lg+ only, iPad portrait uses slide-over) */}
            {selectedImage && (
              <div className="hidden lg:flex w-80 shrink-0 border-l border-white/10 p-4 backdrop-blur-xl bg-white/[0.03] flex-col">
                <ImageDetails
                  image={selectedImage}
                  onUseParams={handleUseParams}
                  onOpenLightbox={setLightboxImage}
                />
              </div>
            )}

            {/* Slide-up drawer - Controls (lg- only, desktop uses sidebar) */}
            {controlsOpen && (
              <div className="lg:hidden fixed inset-0 z-50 flex items-end">
                <div
                  className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
                  style={{ opacity: controlsOpen ? 0.6 : 0 }}
                  onClick={() => setControlsOpen(false)}
                />
                <div
                  ref={controlsDrawerRef}
                  className="relative w-full max-h-[85vh] bg-[#0f0f14] border-t border-white/10 rounded-t-2xl overflow-hidden flex flex-col"
                  onTouchStart={(e) => {
                    const touch = e.touches[0];
                    const startY = touch.clientY;
                    const drawer = controlsDrawerRef.current;
                    if (!drawer) return;
                    const rect = drawer.getBoundingClientRect();
                    const scrollTop = drawer.querySelector('.overflow-y-auto')?.scrollTop || 0;
                    
                    // Only drag if at top of scrollable content
                    if (scrollTop > 10) return;
                    
                    const handleMove = (moveEvent: TouchEvent) => {
                      const dy = moveEvent.touches[0].clientY - startY;
                      if (dy > 0) {
                        drawer.style.transform = `translateY(${dy}px)`;
                      }
                    };
                    
                    const handleEnd = (endEvent: TouchEvent) => {
                      const dy = endEvent.changedTouches[0].clientY - startY;
                      drawer.style.transition = 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
                      
                      if (dy > 100) {
                        drawer.style.transform = 'translateY(100%)';
                        setTimeout(() => setControlsOpen(false), 250);
                      } else {
                        drawer.style.transform = 'translateY(0)';
                      }
                      
                      document.removeEventListener('touchmove', handleMove);
                      document.removeEventListener('touchend', handleEnd);
                    };
                    
                    document.addEventListener('touchmove', handleMove, { passive: true });
                    document.addEventListener('touchend', handleEnd);
                  }}
                >
                  <DragHandle onDoubleTap={() => setControlsOpen(false)} />
                  <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-white/10">
                    <h3 className="text-sm font-semibold text-white/90">Generation Controls</h3>
                    <button
                      onClick={() => setControlsOpen(false)}
                      className="text-white/40 hover:text-white/70 transition-colors p-1.5 rounded-lg hover:bg-white/5 pressable"
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

            {/* Slide-up drawer - Details (lg- only, desktop uses sidebar) */}
            {detailsOpen && selectedImage && (
              <div className="lg:hidden fixed inset-0 z-50 flex items-end">
                <div
                  className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
                  style={{ opacity: detailsOpen ? 0.6 : 0 }}
                  onClick={() => setDetailsOpen(false)}
                />
                <div
                  ref={detailsDrawerRef}
                  className="relative w-full max-h-[85vh] bg-[#0f0f14] border-t border-white/10 rounded-t-2xl overflow-hidden flex flex-col"
                  onTouchStart={(e) => {
                    const touch = e.touches[0];
                    const startY = touch.clientY;
                    const drawer = detailsDrawerRef.current;
                    if (!drawer) return;
                    const scrollTop = drawer.querySelector('.overflow-y-auto')?.scrollTop || 0;
                    
                    // Only drag if at top of scrollable content
                    if (scrollTop > 10) return;
                    
                    const handleMove = (moveEvent: TouchEvent) => {
                      const dy = moveEvent.touches[0].clientY - startY;
                      if (dy > 0) {
                        drawer.style.transform = `translateY(${dy}px)`;
                      }
                    };
                    
                    const handleEnd = (endEvent: TouchEvent) => {
                      const dy = endEvent.changedTouches[0].clientY - startY;
                      drawer.style.transition = 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
                      
                      if (dy > 100) {
                        drawer.style.transform = 'translateY(100%)';
                        setTimeout(() => setDetailsOpen(false), 250);
                      } else {
                        drawer.style.transform = 'translateY(0)';
                      }
                      
                      document.removeEventListener('touchmove', handleMove);
                      document.removeEventListener('touchend', handleEnd);
                    };
                    
                    document.addEventListener('touchmove', handleMove, { passive: true });
                    document.addEventListener('touchend', handleEnd);
                  }}
                >
                  <DragHandle onDoubleTap={() => setDetailsOpen(false)} />
                  <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-white/10">
                    <h3 className="text-sm font-semibold text-white/90">Image Details</h3>
                    <button
                      onClick={() => setDetailsOpen(false)}
                      className="text-white/40 hover:text-white/70 transition-colors p-1.5 rounded-lg hover:bg-white/5 pressable"
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
                  className="absolute top-4 right-4 p-2 rounded-lg text-white hover:text-white hover:bg-white/10 transition-colors z-10 pressable"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-50 hover:opacity-90 transition-opacity">
                    <path d="M18 6L6 18" />
                    <path d="M6 6l12 12" />
                  </svg>
                </button>
                {/* Prev button */}
                <button
                  onClick={(e) => { e.stopPropagation(); navigateImage(-1); }}
                  disabled={!hasPrevImage}
                  className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/40 text-white/60 hover:text-white/90 hover:bg-black/60 transition-all disabled:opacity-20 disabled:pointer-events-none z-10 pressable"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>
                {/* Next button */}
                <button
                  onClick={(e) => { e.stopPropagation(); navigateImage(1); }}
                  disabled={!hasNextImage}
                  className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/40 text-white/60 hover:text-white/90 hover:bg-black/60 transition-all disabled:opacity-20 disabled:pointer-events-none z-10 pressable"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </button>
                <ProgressiveImage
                  src={lightboxUrl}
                  thumbSrc={`${lightboxImage.url}/thumb`}
                  alt={lightboxImage.description || lightboxImage.params?.positivePrompt?.slice(0, 50) || "Image"}
                  className="w-[90vw] h-[90vh]"
                  width={lightboxImage.params?.width || undefined}
                  height={lightboxImage.params?.height || undefined}
                  onClick={() => {}}
                />
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-black/60 text-xs text-white/60 font-mono">
                  {lightboxImage.params?.width && lightboxImage.params?.height
                    ? `${lightboxImage.params.width}x${lightboxImage.params.height} · `
                    : ""
                  }
                  {lightboxImage.resolvedSeed ? `seed: ${lightboxImage.resolvedSeed} · ` : ""}
                  {lightboxImage.params?.model || lightboxImage.type || "image"}
                </div>
              </div>
            )}
          </>
        ) : mode === "corpus" ? (
          /* Corpus mode: force-directed graph visualization */
          <CorpusView />
        ) : (
          <>
            {/* Vision Controls - desktop sidebar (lg+ only, iPad portrait uses slide-over) */}
            <div className="hidden lg:block w-80 shrink-0 border-r border-white/10 backdrop-blur-xl bg-white/[0.03]">
              <VisionControls
                presets={presets}
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
                      <PolyhedronLogo isActive={true} count={3} size={20} gap={2} speed={0.8} shape={activityShape} />
                      <span className="text-xs text-white/40">Analyzing...</span>
                    </div>
                  </div>
                  {streamingThinking && (
                    <ThinkingBlock
                      thinking={streamingThinking}
                      isStreaming={analyzing}
                      thinkingActive={analyzing}
                    />
                  )}
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
                  streamingThinking={streamingThinking}
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
                      fill="currentColor"
                      className="mx-auto opacity-50"
                    >
                      <path fill-rule="evenodd" clip-rule="evenodd" d="M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2ZM5 5v14h14V5H5ZM9 7a2 2 0 110 4 2 2 0 010-4ZM5 19l3.5-4.5 3 3 4-5.5L19 15v4H5Z" />
                    </svg>
                    <p className="text-sm">Upload an image to get started</p>
                  </div>
                </div>
              )}
            </div>

            {/* Slide-up drawer - Vision Controls (lg- only, desktop uses sidebar) */}
            {controlsOpen && mode === "analyze" && (
              <div className="lg:hidden fixed inset-0 z-50 flex items-end">
                <div
                  className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
                  style={{ opacity: controlsOpen ? 0.6 : 0 }}
                  onClick={() => setControlsOpen(false)}
                />
                <div
                  ref={controlsDrawerRef}
                  className="relative w-full max-h-[85vh] bg-[#0f0f14] border-t border-white/10 rounded-t-2xl overflow-hidden flex flex-col"
                  onTouchStart={(e) => {
                    const touch = e.touches[0];
                    const startY = touch.clientY;
                    const drawer = controlsDrawerRef.current;
                    if (!drawer) return;
                    const scrollTop = drawer.querySelector('.overflow-y-auto')?.scrollTop || 0;
                    
                    // Only drag if at top of scrollable content
                    if (scrollTop > 10) return;
                    
                    const handleMove = (moveEvent: TouchEvent) => {
                      const dy = moveEvent.touches[0].clientY - startY;
                      if (dy > 0) {
                        drawer.style.transform = `translateY(${dy}px)`;
                      }
                    };
                    
                    const handleEnd = (endEvent: TouchEvent) => {
                      const dy = endEvent.changedTouches[0].clientY - startY;
                      drawer.style.transition = 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
                      
                      if (dy > 100) {
                        drawer.style.transform = 'translateY(100%)';
                        setTimeout(() => setControlsOpen(false), 250);
                      } else {
                        drawer.style.transform = 'translateY(0)';
                      }
                      
                      document.removeEventListener('touchmove', handleMove);
                      document.removeEventListener('touchend', handleEnd);
                    };
                    
                    document.addEventListener('touchmove', handleMove, { passive: true });
                    document.addEventListener('touchend', handleEnd);
                  }}
                >
                  <DragHandle onDoubleTap={() => setControlsOpen(false)} />
                  <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-white/10">
                    <h3 className="text-sm font-semibold text-white/90">Vision Controls</h3>
                    <button
                      onClick={() => setControlsOpen(false)}
                      className="text-white/40 hover:text-white/70 transition-colors p-1.5 rounded-lg hover:bg-white/5 pressable"
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

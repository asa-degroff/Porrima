import { useState, useCallback, useEffect, memo } from "react";
import type { GeneratedImage, GenerationState } from "../types";
import { precacheImages } from "../utils/imageCache";

interface Props {
  images: GeneratedImage[];
  selectedImage: GeneratedImage | null;
  onSelect: (image: GeneratedImage) => void;
  onDelete?: (id: string) => void;
  activeGenerations?: GenerationState[];
  searchResults?: GeneratedImage[];
  isSearching?: boolean;
}

/** A single image tile — memoized so it survives parent list changes. */
const ImageTile = memo(function ImageTile({
  image,
  isSelected,
  onSelect,
  onDelete,
}: {
  image: GeneratedImage;
  isSelected: boolean;
  onSelect: (image: GeneratedImage) => void;
  onDelete?: (id: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!confirmDelete) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setConfirmDelete(false); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [confirmDelete]);

  return (
    <button
      onClick={() => onSelect(image)}
      className={`group relative w-full rounded-xl overflow-hidden border-2 transition-all hover:scale-[1.02] break-inside-avoid ${
        isSelected
          ? "border-amber-400/60 ring-2 ring-amber-400/20"
          : "border-white/10 hover:border-white/20"
      }`}
      style={{ contain: 'content' }}
    >
      <img
        src={`${image.url}/thumb`}
        alt={image.params?.positivePrompt?.slice(0, 50) || image.description?.slice(0, 50) || "Image"}
        loading="lazy"
        decoding="async"
        className="w-full h-auto block"
      />
      {/* Hover overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="absolute bottom-0 left-0 right-0 p-2 space-y-0.5">
          {('resolvedSeed' in image) && (
            <p className="text-[10px] text-white/70 font-mono">seed: {(image as any).resolvedSeed}</p>
          )}
          {('params' in image) && (image as any).params?.model && (
            <p className="text-[10px] text-white/50 truncate">{(image as any).params.model}</p>
          )}
          {'score' in image && typeof image.score === 'number' && (
            <p className="text-[10px] text-purple-300/70">relevance: {(image.score * 100).toFixed(1)}%</p>
          )}
        </div>
      </div>
      {/* Delete button */}
      {onDelete && (
        <div
          onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
          className="absolute top-1.5 right-1.5 p-1 rounded-md bg-black/50 text-white/40 hover:text-red-400 hover:bg-black/70 opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
          title="Delete"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18" />
            <path d="M6 6l12 12" />
          </svg>
        </div>
      )}
      {/* Delete confirmation overlay */}
      {confirmDelete && (
        <div
          className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-2 z-10"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-xs text-white/80">Delete this image?</p>
          <div className="flex gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); onDelete?.(image.id); setConfirmDelete(false); }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/25 border border-red-400/30 text-red-300 hover:bg-red-500/40 transition-all"
            >
              Delete
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 border border-white/15 text-white/60 hover:text-white/80 hover:bg-white/15 transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </button>
  );
});

/** Masonry grid of image tiles — memoized to avoid re-layout when only the sibling layer changes. */
const ImageGrid = memo(function ImageGrid({
  images,
  selectedImage,
  onSelect,
  onDelete,
  activeGenerations,
}: {
  images: GeneratedImage[];
  selectedImage: GeneratedImage | null;
  onSelect: (image: GeneratedImage) => void;
  onDelete?: (id: string) => void;
  activeGenerations: GenerationState[];
}) {
  return (
    <div className="columns-2 md:columns-3 lg:columns-4 gap-3 space-y-3">
      {/* Active generations (queued/processing) */}
      {activeGenerations.map((gen) => (
        <div
          key={gen.id}
          className="group relative w-full rounded-xl overflow-hidden border-2 border-purple-400/40 bg-purple-500/5 break-inside-avoid"
          style={{ contain: 'content' }}
        >
          <div className="aspect-square w-full flex flex-col items-center justify-center gap-3 p-4">
            {gen.status === "queued" ? (
              <>
                <div className="relative">
                  <div className="w-10 h-10 rounded-full border-2 border-purple-400/30 border-t-purple-400 animate-spin" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-purple-400/60">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </div>
                </div>
                <span className="text-xs text-purple-300/70 font-medium">Queued</span>
              </>
            ) : gen.status === "processing" && gen.progress ? (
              <>
                <div className="relative">
                  <svg width="60" height="60" viewBox="0 0 100 100" className="rotate-[-90deg]">
                    <circle cx="50" cy="50" r="40" stroke="currentColor" strokeWidth="8" fill="none" className="text-purple-500/20" />
                    <circle cx="50" cy="50" r="40" stroke="currentColor" strokeWidth="8" fill="none"
                      strokeDasharray={`${(gen.progress.step / gen.progress.total) * 251.2} 251.2`}
                      className="text-purple-400 transition-all duration-300" strokeLinecap="round" />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-xs font-mono text-purple-300">
                      {Math.round((gen.progress.step / gen.progress.total) * 100)}%
                    </span>
                  </div>
                </div>
                <span className="text-xs text-purple-300/70 font-medium">
                  Step {gen.progress.step}/{gen.progress.total}
                </span>
              </>
            ) : (
              <>
                <div className="w-10 h-10 rounded-full border-2 border-purple-400/30 border-t-purple-400 animate-spin" />
                <span className="text-xs text-purple-300/70 font-medium">Starting...</span>
              </>
            )}
          </div>
          <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/80 to-transparent">
            <p className="text-[10px] text-white/60 line-clamp-2 leading-tight">
              {gen.params.positivePrompt.slice(0, 60)}
              {gen.params.positivePrompt.length > 60 ? "..." : ""}
            </p>
          </div>
        </div>
      ))}

      {images.map((image) => (
        <ImageTile
          key={image.id}
          image={image}
          isSelected={selectedImage?.id === image.id}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
});

export function ImageGallery({ images, selectedImage, onSelect, onDelete, activeGenerations = [], searchResults, isSearching }: Props) {
  const hasSearch = searchResults !== undefined;
  const selectedImageUrl = selectedImage?.url;

  // Pre-cache search result images in background (low priority)
  useEffect(() => {
    if (searchResults) {
      // Filter out the currently selected image - it will be loaded with high priority
      const toPrecache = searchResults
        .map(img => img.url)
        .filter(url => url !== selectedImageUrl);
      precacheImages(toPrecache);
    }
  }, [searchResults, selectedImageUrl]);
  
  // Pre-cache gallery images when not searching (low priority)
  useEffect(() => {
    if (!hasSearch && images.length > 0) {
      // Filter out the currently selected image
      const toPrecache = images
        .map(img => img.url)
        .filter(url => url !== selectedImageUrl);
      precacheImages(toPrecache);
    }
  }, [images, hasSearch, selectedImageUrl]);

  const emptyState = (searching: boolean, message: string, sub: string) => (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-3 px-6">
        <div className="w-16 h-16 mx-auto rounded-2xl bg-amber-500/10 border border-amber-400/20 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400/50">
            <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
          </svg>
        </div>
        <p className="text-white/30 text-sm">{message}</p>
        <p className="text-white/20 text-xs">{sub}</p>
      </div>
    </div>
  );

  return (
    <div className="flex-1 overflow-hidden relative">
      {/* Gallery layer — always mounted, hidden behind search results when active */}
      <div
        className="absolute inset-0 overflow-y-auto p-4"
        style={{ visibility: hasSearch ? "hidden" : "visible" }}
      >
        {images.length === 0 ? (
          emptyState(false, "No images generated yet", "Enter a prompt and click Generate")
        ) : (
          <ImageGrid
            images={images}
            selectedImage={selectedImage}
            onSelect={onSelect}
            onDelete={onDelete}
            activeGenerations={activeGenerations}
          />
        )}
      </div>

      {/* Search results layer — mounted only while searching */}
      {hasSearch && (
        <div className="absolute inset-0 overflow-y-auto p-4">
          {searchResults.length === 0 ? (
            emptyState(true, "No images match your search", "Try different keywords")
          ) : (
            <ImageGrid
              images={searchResults}
              selectedImage={selectedImage}
              onSelect={onSelect}
              onDelete={onDelete}
              activeGenerations={[]}
            />
          )}
        </div>
      )}
    </div>
  );
}

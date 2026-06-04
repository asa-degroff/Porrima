import { useState, useEffect, memo, useMemo } from "react";
import type { GeneratedImage, GenerationState, ActivityShape } from "../types";
import { precacheImages } from "../utils/imageCache";
import { PolyhedronLogo } from "./PolyhedronLogo";
import { useActivityShape } from "../hooks/useActivityStyle";

interface Props {
  images: GeneratedImage[];
  selectedImage: GeneratedImage | null;
  onSelect: (image: GeneratedImage) => void;
  onDelete?: (id: string) => void;
  onToggleFavorite?: (id: string) => Promise<void>;
  activeGenerations?: GenerationState[];
  searchResults?: GeneratedImage[];
  isSearching?: boolean;
  showFavoritesOnly?: boolean;
}

function getImageAspectRatio(image: GeneratedImage): string {
  const width = image.params?.width;
  const height = image.params?.height;
  if (width && height && width > 0 && height > 0) {
    return `${width} / ${height}`;
  }
  return "1 / 1";
}

/** A single image tile — memoized so it survives parent list changes. */
const ImageTile = memo(function ImageTile({
  image,
  isSelected,
  onSelect,
  onDelete,
  onToggleFavorite,
}: {
  image: GeneratedImage;
  isSelected: boolean;
  onSelect: (image: GeneratedImage) => void;
  onDelete?: (id: string) => void;
  onToggleFavorite?: (id: string) => Promise<void>;
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
      style={{ contain: 'content', aspectRatio: getImageAspectRatio(image) }}
    >
      <img
        src={`${image.url}/thumb`}
        alt={image.params?.positivePrompt?.slice(0, 50) || image.description?.slice(0, 50) || "Image"}
        loading="lazy"
        decoding="async"
        className="w-full h-full object-cover block"
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
          className="absolute top-1.5 right-1.5 p-1 rounded-md bg-black/50 text-white/40 hover:text-red-400 hover:bg-black/70 opacity-0 group-hover:opacity-100 transition-all cursor-pointer z-10 pressable"
          title="Delete"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18" />
            <path d="M6 6l12 12" />
          </svg>
        </div>
      )}
      {/* Favorite button */}
      {onToggleFavorite && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(image.id); }}
          className={`absolute top-1.5 left-1.5 p-1.5 rounded-full backdrop-blur-sm transition-all cursor-pointer z-5 pressable ${
            image.isFavorite
              ? "bg-rose-500/20 text-rose-400"
              : "bg-black/40 text-white/30 hover:text-rose-400 hover:bg-black/60 opacity-0 group-hover:opacity-100"
          }`}
          title={image.isFavorite ? "Remove from favorites" : "Add to favorites"}
        >
          <svg 
            xmlns="http://www.w3.org/2000/svg" 
            width="16" 
            height="16" 
            viewBox="0 0 24 24" 
            fill={image.isFavorite ? "currentColor" : "none"} 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
          >
            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
          </svg>
        </button>
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
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/25 border border-red-400/30 text-red-300 hover:bg-red-500/40 transition-all pressable"
            >
              Delete
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 border border-white/15 text-white/60 hover:text-white/80 hover:bg-white/15 transition-all pressable"
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
  onToggleFavorite,
  activeGenerations,
  activityShape,
}: {
  images: GeneratedImage[];
  selectedImage: GeneratedImage | null;
  onSelect: (image: GeneratedImage) => void;
  onDelete?: (id: string) => void;
  onToggleFavorite?: (id: string) => Promise<void>;
  activeGenerations: GenerationState[];
  activityShape: ActivityShape;
}) {
  return (
    <div className="columns-2 md:columns-3 lg:columns-4 gap-3 space-y-3">
      {/* Active generations (queued/processing) */}
      {activeGenerations.map((gen) => {
        const minHeight = 160; // minimum height to fit octahedron + progress bar + text
        const width = gen.params.width || 1;
        const height = gen.params.height || 1;
        
        return (
          <div
            key={gen.id}
            className="group relative w-full rounded-xl overflow-hidden border-2 border-purple-400/40 bg-purple-500/5 break-inside-avoid"
            style={{ 
              contain: 'content',
              aspectRatio: `${width} / ${height}`,
              minHeight: minHeight
            }}
          >
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4">
              {gen.status === "queued" ? (
                <>
                  <PolyhedronLogo isActive={true} count={1} size={40} gap={0} speed={0.6} shape={activityShape} />
                  <span className="text-xs text-purple-300/70 font-medium">Queued</span>
                </>
              ) : gen.status === "processing" && gen.progress ? (
                <>
                  <PolyhedronLogo isActive={true} count={3} size={40} gap={0} speed={0.5} shape={activityShape} />
                  <div className="w-full max-w-[120px] space-y-1.5">
                    <div className="h-1.5 bg-purple-500/20 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-purple-400 rounded-full transition-all duration-300"
                        style={{ width: `${(gen.progress.step / gen.progress.total) * 100}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] text-purple-300/60 font-mono">
                      <span>Step {gen.progress.step}/{gen.progress.total}</span>
                      <span>{Math.round((gen.progress.step / gen.progress.total) * 100)}%</span>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <PolyhedronLogo isActive={true} count={1} size={40} gap={0} speed={0.8} shape={activityShape} />
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
        );
      })}

      {images.map((image) => (
        <ImageTile
          key={image.id}
          image={image}
          isSelected={selectedImage?.id === image.id}
          onSelect={onSelect}
          onDelete={onDelete}
          onToggleFavorite={onToggleFavorite}
        />
      ))}
    </div>
  );
});

export function ImageGallery({ images, selectedImage, onSelect, onDelete, onToggleFavorite, activeGenerations = [], searchResults, isSearching, showFavoritesOnly = false }: Props) {
  const activityShape = useActivityShape();
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
          <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="currentColor" className="text-amber-400/50">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2ZM5 5v14h14V5H5ZM9 7a2 2 0 110 4 2 2 0 010-4ZM5 19l3.5-4.5 3 3 4-5.5L19 15v4H5Z" />
          </svg>
        </div>
        <p className="text-white/30 text-sm">{message}</p>
        <p className="text-white/20 text-xs">{sub}</p>
      </div>
    </div>
  );

  const visibleImages = useMemo(() => {
    const source = searchResults ?? images;
    return showFavoritesOnly ? source.filter((i) => i.isFavorite) : source;
  }, [images, searchResults, showFavoritesOnly]);

  const emptyCopy = hasSearch
    ? ["No images match your search", "Try different keywords"]
    : showFavoritesOnly
      ? ["No favorited images", "Tap the heart on images to add them to favorites"]
      : ["No images generated yet", "Enter a prompt and click Generate"];

  return (
    <div className="flex-1 overflow-hidden relative">
      <div className="absolute inset-0 overflow-y-auto p-4">
        {visibleImages.length === 0 ? (
          emptyState(Boolean(isSearching), emptyCopy[0], emptyCopy[1])
        ) : (
          <ImageGrid
            images={visibleImages}
            selectedImage={selectedImage}
            onSelect={onSelect}
            onDelete={onDelete}
            onToggleFavorite={onToggleFavorite}
            activeGenerations={hasSearch ? [] : activeGenerations}
            activityShape={activityShape}
          />
        )}
      </div>
    </div>
  );
}

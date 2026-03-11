import { useState, useCallback, useEffect } from "react";
import type { GeneratedImage } from "../types";
import { precacheImages } from "../utils/imageCache";

interface Props {
  images: GeneratedImage[];
  selectedImage: GeneratedImage | null;
  onSelect: (image: GeneratedImage) => void;
  onDelete?: (id: string) => void;
}

export function ImageGallery({ images, selectedImage, onSelect, onDelete }: Props) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Pre-cache full images in background so detail view is instant
  useEffect(() => {
    precacheImages(images.map((img) => img.url));
  }, [images]);

  // Close confirmation on Escape
  useEffect(() => {
    if (!confirmDeleteId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmDeleteId(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [confirmDeleteId]);

  const handleDeleteClick = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setConfirmDeleteId(id);
  }, []);

  const handleConfirmDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDeleteId && onDelete) {
      onDelete(confirmDeleteId);
      setConfirmDeleteId(null);
    }
  }, [confirmDeleteId, onDelete]);

  const handleCancelDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteId(null);
  }, []);

  if (images.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3 px-6">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-amber-500/10 border border-amber-400/20 flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400/50">
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
            </svg>
          </div>
          <p className="text-white/30 text-sm">No images generated yet</p>
          <p className="text-white/20 text-xs">Enter a prompt and click Generate</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="columns-2 md:columns-3 lg:columns-4 gap-3 space-y-3">
        {images.map((image) => (
          <button
            key={image.id}
            onClick={() => onSelect(image)}
            className={`group relative w-full rounded-xl overflow-hidden border-2 transition-all hover:scale-[1.02] break-inside-avoid ${
              selectedImage?.id === image.id
                ? "border-amber-400/60 ring-2 ring-amber-400/20"
                : "border-white/10 hover:border-white/20"
            }`}
          >
            <img
              src={`${image.url}/thumb`}
              alt={image.params.positivePrompt.slice(0, 50)}
              loading="lazy"
              decoding="async"
              className="w-full h-auto block"
            />
            {/* Hover overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
              <div className="absolute bottom-0 left-0 right-0 p-2 space-y-0.5">
                <p className="text-[10px] text-white/70 font-mono">seed: {image.resolvedSeed}</p>
                <p className="text-[10px] text-white/50 truncate">{image.params.model}</p>
              </div>
            </div>
            {/* Delete button */}
            {onDelete && (
              <div
                onClick={(e) => handleDeleteClick(e, image.id)}
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
            {confirmDeleteId === image.id && (
              <div
                className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-2 z-10"
                onClick={(e) => e.stopPropagation()}
              >
                <p className="text-xs text-white/80">Delete this image?</p>
                <div className="flex gap-2">
                  <button
                    onClick={handleConfirmDelete}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/25 border border-red-400/30 text-red-300 hover:bg-red-500/40 transition-all"
                  >
                    Delete
                  </button>
                  <button
                    onClick={handleCancelDelete}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 border border-white/15 text-white/60 hover:text-white/80 hover:bg-white/15 transition-all"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

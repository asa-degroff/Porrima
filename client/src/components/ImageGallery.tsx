import { useState, useCallback, useEffect } from "react";
import type { GeneratedImage } from "../types";

interface Props {
  images: GeneratedImage[];
  selectedImage: GeneratedImage | null;
  onSelect: (image: GeneratedImage) => void;
}

export function ImageGallery({ images, selectedImage, onSelect }: Props) {
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
    <>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="columns-2 md:columns-3 lg:columns-4 gap-3 space-y-3">
          {images.map((image) => (
            <button
              key={image.id}
              onClick={() => onSelect(image)}
              onDoubleClick={() => setLightboxImage(image)}
              className={`group relative w-full rounded-xl overflow-hidden border-2 transition-all hover:scale-[1.02] break-inside-avoid ${
                selectedImage?.id === image.id
                  ? "border-amber-400/60 ring-2 ring-amber-400/20"
                  : "border-white/10 hover:border-white/20"
              }`}
            >
              <img
                src={image.url}
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
                {/* Expand icon */}
                <div className="absolute top-2 right-2">
                  <div
                    className="p-1 rounded-md bg-black/40 text-white/60 hover:text-white/90 hover:bg-black/60 transition-colors cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      setLightboxImage(image);
                    }}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 3 21 3 21 9" />
                      <polyline points="9 21 3 21 3 15" />
                      <line x1="21" y1="3" x2="14" y2="10" />
                      <line x1="3" y1="21" x2="10" y2="14" />
                    </svg>
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

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
  );
}

import { useCallback } from "react";
import type { GeneratedImage } from "../types";

interface Props {
  images: GeneratedImage[];
  selectedImage: GeneratedImage | null;
  onSelect: (image: GeneratedImage) => void;
}

export function ImageCarousel({ images, selectedImage, onSelect }: Props) {
  const handleSelect = useCallback((image: GeneratedImage) => {
    onSelect(image);
  }, [onSelect]);

  if (images.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-white/10 bg-white/[0.02]">
      <div className="flex gap-2 p-2 overflow-x-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
        {images.map((image) => {
          const isSelected = selectedImage?.id === image.id;
          
          return (
            <button
              key={image.id}
              onClick={() => handleSelect(image)}
              className={`relative flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 transition-all hover:scale-105 ${
                isSelected
                  ? "border-amber-400/60 ring-2 ring-amber-400/20"
                  : "border-white/10 hover:border-white/20"
              }`}
              title={image.params.positivePrompt.slice(0, 80)}
            >
              <img
                src={`${image.url}/thumb`}
                alt={image.params.positivePrompt.slice(0, 50)}
                loading="lazy"
                className="w-full h-full object-cover"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

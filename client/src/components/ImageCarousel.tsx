import { useCallback, useRef, useEffect, memo } from "react";
import type { GeneratedImage } from "../types";

interface Props {
  images: GeneratedImage[];
  selectedImage: GeneratedImage | null;
  onSelect: (image: GeneratedImage) => void;
}

const CarouselTile = memo(function CarouselTile({
  image,
  isSelected,
  onSelect,
}: {
  image: GeneratedImage;
  isSelected: boolean;
  onSelect: (image: GeneratedImage) => void;
}) {
  const label = image.description || image.params?.positivePrompt || "";
  return (
    <button
      onClick={() => onSelect(image)}
      className={`relative flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 transition-all hover:scale-105 ${
        isSelected
          ? "border-amber-400/60 ring-2 ring-amber-400/20"
          : "border-white/10 hover:border-white/20"
      }`}
      title={label.slice(0, 80)}
    >
      <img
        src={`${image.url}/thumb`}
        alt={label.slice(0, 50) || "Image"}
        loading="lazy"
        className="w-full h-full object-cover"
      />
    </button>
  );
});

export function ImageCarousel({ images, selectedImage, onSelect }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to keep the selected thumbnail visible
  useEffect(() => {
    if (!selectedImage || !scrollRef.current) return;
    const idx = images.findIndex((img) => img.id === selectedImage.id);
    if (idx < 0) return;
    const child = scrollRef.current.children[idx] as HTMLElement | undefined;
    child?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [selectedImage, images]);

  if (images.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-white/10 bg-white/[0.02]">
      <div
        ref={scrollRef}
        className="flex gap-2 p-2 overflow-x-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent"
      >
        {images.map((image) => (
          <CarouselTile
            key={image.id}
            image={image}
            isSelected={selectedImage?.id === image.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

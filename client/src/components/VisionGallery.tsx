import type { AnalyzedImage } from "../api/client";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface Props {
  images: AnalyzedImage[];
  selectedImage: AnalyzedImage | null;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function VisionGallery({ images, selectedImage, onSelect, onDelete }: Props) {
  if (images.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-white/40">
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
          <p>No analyzed images yet</p>
          <p className="text-xs">Upload an image to get started</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {images.map((image) => (
          <div
            key={image.id}
            onClick={() => onSelect(image.id)}
            className={`
              group relative aspect-square rounded-lg overflow-hidden cursor-pointer
              border-2 transition-all duration-200
              ${selectedImage?.id === image.id
                ? "border-white/60 shadow-lg shadow-white/10"
                : "border-white/10 hover:border-white/30"
              }
            `}
          >
            <img
              src={image.url}
              alt={image.filename}
              className="w-full h-full object-cover"
              loading="lazy"
            />
            
            {/* Overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
              <div className="absolute bottom-0 left-0 right-0 p-2">
                <div className="text-xs text-white/60 line-clamp-2">
                  <MarkdownRenderer content={image.description.slice(0, 100)} />
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[10px] text-white/40">{image.preset}</span>
                  {onDelete && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(image.id);
                      }}
                      className="text-white/40 hover:text-red-400 transition-colors p-1"
                      title="Delete"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18" />
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Selected indicator */}
            {selectedImage?.id === image.id && (
              <div className="absolute top-2 right-2 w-5 h-5 bg-white/20 backdrop-blur-sm rounded-full flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

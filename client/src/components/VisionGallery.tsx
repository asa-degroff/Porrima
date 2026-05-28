import type { AnalyzedImage } from "../api/client";
import { MarkdownRenderer } from "./ui/MarkdownRenderer";

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
            fill="currentColor"
            className="mx-auto opacity-50"
          >
            <path fill-rule="evenodd" clip-rule="evenodd" d="M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2ZM5 5v14h14V5H5ZM9 7a2 2 0 110 4 2 2 0 010-4ZM5 19l3.5-4.5 3 3 4-5.5L19 15v4H5Z" />
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
                      <svg className="trash-icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ overflow: 'visible' }}>
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                        <g className="trash-lid">
                          <path d="M3 6h18" />
                          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                        </g>
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

/**
 * ImageLightbox - full-screen image viewer shared by chat bubbles and tool
 * call displays. Resolves the display source from a server URL when one is
 * available, otherwise builds a transient object URL from base64 data.
 * The owning component portal-mounts it and owns the open/close state.
 */

import { useEffect, useState } from "react";
import type { ImageAttachment } from "../types";

export function ImageLightbox({ image, onClose }: { image: ImageAttachment; onClose: () => void }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    // Use server URL for full image if available
    if (image.url) {
      setObjectUrl(image.url);
      return;
    }

    if (!image.data) {
      setObjectUrl(null);
      return;
    }

    // Fall back to object URL from base64
    const binaryString = atob(image.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: image.mimeType });
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [image.url, image.data, image.mimeType]);

  if (!objectUrl) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center app-modal-backdrop app-modal-backdrop-strong"
        onClick={onClose}
      >
        <div className="w-8 h-8 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center app-modal-backdrop app-modal-backdrop-strong"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white text-2xl flex items-center justify-center transition-colors"
      >
        ×
      </button>
      <img
        src={objectUrl}
        alt={image.name}
        onClick={(e) => e.stopPropagation()}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
      />
      <span className="absolute bottom-4 text-white/50 text-sm">{image.name}</span>
    </div>
  );
}

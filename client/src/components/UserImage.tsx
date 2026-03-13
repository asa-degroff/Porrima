/**
 * UserImage component - displays user-uploaded images with efficient loading.
 * Prefers server-side thumbnails when available, falls back to client-side processing.
 */

import { useState, useEffect, useCallback, memo } from "react";
import type { ImageAttachment } from "../types";
import { base64ToRenderableUrl, revokeObjectUrl } from "../utils/image";

interface UserImageProps {
  image: ImageAttachment;
  maxDimension?: number;
  quality?: number;
  onClick?: () => void;
}

export const UserImage = memo(function UserImage({
  image,
  maxDimension = 800,
  quality = 0.7,
  onClick,
}: UserImageProps) {
  const [displaySrc, setDisplaySrc] = useState<string | null>(
    // If we have a thumbUrl, use it immediately — no loading state needed
    image.thumbUrl ?? null
  );
  const [loading, setLoading] = useState(!image.thumbUrl);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // If server-side thumbnail is available, use it directly
    if (image.thumbUrl) {
      setDisplaySrc(image.thumbUrl);
      setLoading(false);
      return;
    }

    // Fall back to client-side base64 → object URL conversion
    let cancelled = false;
    let objectUrl: string | null = null;

    async function loadImage() {
      try {
        objectUrl = await base64ToRenderableUrl(image.data, image.mimeType, maxDimension, quality);

        if (!cancelled) {
          setDisplaySrc(objectUrl);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load image");
          setLoading(false);
          setDisplaySrc(`data:${image.mimeType};base64,${image.data}`);
        }
      }
    }

    loadImage();

    return () => {
      cancelled = true;
      if (objectUrl) {
        revokeObjectUrl(objectUrl);
      }
    };
  }, [image.thumbUrl, image.data, image.mimeType, maxDimension, quality]);

  const handleClick = useCallback(() => {
    onClick?.();
  }, [onClick]);

  if (loading) {
    return (
      <div
        className="rounded-lg bg-white/5 border border-white/10"
        style={{ width: 150, height: 150 }}
      >
        <div className="flex items-center justify-center h-full">
          <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (error || !displaySrc) {
    return (
      <div
        className="rounded-lg bg-red-500/10 border border-red-400/20 flex items-center justify-center"
        style={{ width: 150, height: 150 }}
      >
        <span className="text-red-300 text-xs">Image load failed</span>
      </div>
    );
  }

  return (
    <img
      src={displaySrc}
      alt={image.name}
      loading="lazy"
      decoding="async"
      onClick={handleClick}
      className="rounded-lg max-h-64 cursor-pointer hover:opacity-90 transition-opacity"
      style={{ maxWidth: "100%", width: "auto", height: "auto" }}
    />
  );
});

import { useState, useEffect, useCallback } from "react";

interface Props {
  src: string;
  thumbSrc: string;
  alt: string;
  className?: string;
  onClick?: () => void;
}

/**
 * Progressive image loader that shows thumbnail first, then replaces with full image.
 * Provides instant visual feedback while the full image loads.
 */
export function ProgressiveImage({ src, thumbSrc, alt, className, onClick }: Props) {
  const [displaySrc, setDisplaySrc] = useState(thumbSrc);
  const [loaded, setLoaded] = useState(false);
  const [isInitial, setIsInitial] = useState(true);

  // Preload full image, then swap when ready
  useEffect(() => {
    setLoaded(false);
    setDisplaySrc(thumbSrc);
    setIsInitial(true);

    const img = new Image();
    img.src = src;
    img.onload = () => {
      setDisplaySrc(src);
      // Delay adding blur removal slightly to ensure thumbnail is rendered first
      requestAnimationFrame(() => {
        setIsInitial(false);
        setLoaded(true);
      });
    };
    img.onerror = () => {
      // Keep thumbnail if full image fails
      console.warn("[progressive-image] failed to load full image:", src);
      setIsInitial(false);
    };

    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [src, thumbSrc]);

  return (
    <img
      src={displaySrc}
      alt={alt}
      className={className}
      onClick={onClick}
      style={{
        // Only apply blur during transition, not on initial thumbnail render
        filter: isInitial ? 'blur(4px)' : (loaded ? 'none' : 'blur(4px)'),
        // Only animate when switching from thumbnail to full image
        transition: isInitial ? 'none' : 'filter 0.2s ease-out',
        // Let className control sizing (max-w-full max-h-full object-contain)
        // This ensures shadow is applied to actual image bounds, not container
        display: 'block',
        width: '100%',
        height: '100%',
        objectFit: 'contain'
      }}
    />
  );
}

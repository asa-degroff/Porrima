import { useState, useEffect, useRef, useCallback } from "react";
import { getCachedImage } from "../utils/imageCache";

interface Props {
  src: string;
  thumbSrc: string;
  alt: string;
  className?: string;
  onClick?: () => void;
  /** Full image dimensions — used to calculate rendered size for consistent thumbnail/full display */
  width?: number;
  height?: number;
}

/**
 * Progressive image loader: shows a blurred thumbnail instantly,
 * then cross-fades to the sharp full image when it finishes loading.
 *
 * Uses the Cache API so images precached by the gallery load instantly.
 *
 * Structure: outer container (fills parent, measures available space) →
 * inner wrapper (calculated object-contain size, has rounded corners + shadow) →
 * img (fills wrapper, blur during loading).
 */
export function ProgressiveImage({ src, thumbSrc, alt, className, onClick, width, height }: Props) {
  const [displaySrc, setDisplaySrc] = useState(thumbSrc);
  const [loaded, setLoaded] = useState(false);
  const [isInitial, setIsInitial] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderSize, setRenderSize] = useState<{ w: number; h: number } | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // Measure available space and calculate object-contain dimensions
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !width || !height) return;

    const update = () => {
      const { width: cw, height: ch } = el.getBoundingClientRect();
      if (cw === 0 || ch === 0) return;
      const scale = Math.min(cw / width, ch / height, 1);
      setRenderSize({ w: Math.round(width * scale), h: Math.round(height * scale) });
    };

    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height]);

  // Preload full image via Cache API, swap when ready
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setDisplaySrc(thumbSrc);
    setIsInitial(true);

    // Revoke previous blob URL
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    getCachedImage(src, src).then((resolvedUrl) => {
      if (cancelled) {
        // Clean up blob if we were cancelled
        if (resolvedUrl !== src) URL.revokeObjectURL(resolvedUrl);
        return;
      }

      // If getCachedImage returned a blob URL, track it for cleanup
      if (resolvedUrl !== src) blobUrlRef.current = resolvedUrl;

      // Decode the image before swapping to avoid a paint flash
      const img = new Image();
      img.src = resolvedUrl;
      img.onload = () => {
        if (cancelled) return;
        setDisplaySrc(resolvedUrl);
        requestAnimationFrame(() => {
          if (cancelled) return;
          setIsInitial(false);
          setLoaded(true);
        });
      };
      img.onerror = () => {
        if (cancelled) return;
        console.warn("[progressive-image] failed to load full image:", src);
        setIsInitial(false);
      };
    });

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [src, thumbSrc]);

  const blurring = isInitial || !loaded;

  // Fallback: no dimensions provided, render a plain img
  if (!width || !height) {
    return (
      <img
        src={displaySrc}
        alt={alt}
        className={className}
        onClick={onClick}
        style={{
          filter: blurring ? 'blur(4px)' : 'none',
          transition: isInitial ? 'none' : 'filter 0.3s ease-out',
        }}
      />
    );
  }

  return (
    // Outer: fills parent, provides measurement rect
    <div
      ref={containerRef}
      className={className}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      {/* Inner: exact image dimensions, visual styling */}
      <div
        onClick={onClick}
        style={{
          width: renderSize?.w,
          height: renderSize?.h,
          overflow: 'hidden',
          borderRadius: '0.5rem',
          boxShadow: '0 25px 50px -12px rgb(0 0 0 / 0.35)',
          cursor: onClick ? 'pointer' : undefined,
        }}
      >
        <img
          src={displaySrc}
          alt={alt}
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: blurring ? 'blur(4px)' : 'none',
            transition: isInitial ? 'none' : 'filter 0.3s ease-out, transform 0.3s ease-out',
          }}
        />
      </div>
    </div>
  );
}

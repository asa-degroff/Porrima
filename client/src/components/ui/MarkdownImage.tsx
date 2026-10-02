import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ImageLightbox } from "../ImageLightbox";
import { toLocalImageApiSrc } from "../../utils/localImage";

interface Props {
  src?: string;
  alt?: string;
  title?: string;
}

/**
 * Image renderer for markdown content. Local filesystem paths (renders the
 * agent dropped in /tmp, `~/...`, `file://` URLs) are routed through the
 * server's on-demand `/api/local-images` endpoint; everything else is left
 * as-is. Failures degrade to an inline note instead of the browser's broken
 * image icon, which is the expected outcome once a scratch file is cleaned up.
 */
export function MarkdownImage({ src, alt, title }: Props) {
  const resolved = toLocalImageApiSrc(src) ?? src;
  const [failed, setFailed] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [resolved]);

  if (!resolved) return null;

  if (failed) {
    return (
      <span className="markdown-image-missing" title={src}>
        {alt ? `${alt} — ` : ""}image unavailable
      </span>
    );
  }

  return (
    <>
      <img
        src={resolved}
        alt={alt || ""}
        title={title}
        loading="lazy"
        decoding="async"
        className="markdown-image"
        onClick={(event) => {
          // Images wrapped in a markdown link should open the lightbox, not
          // navigate away from the chat.
          event.preventDefault();
          event.stopPropagation();
          setLightboxOpen(true);
        }}
        onError={() => setFailed(true)}
      />
      {lightboxOpen &&
        createPortal(
          <ImageLightbox
            image={{ url: resolved, name: alt || "image", mimeType: "" }}
            onClose={() => setLightboxOpen(false)}
          />,
          document.body,
        )}
    </>
  );
}

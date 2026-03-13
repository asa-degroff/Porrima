/**
 * Client-side image utilities for resizing and compressing images.
 */

/**
 * Resizes and compresses a base64 image to a maximum dimension and quality.
 * Always converts to WebP for better compression (supported in all modern browsers).
 * Returns a compressed base64 string with WebP mimeType.
 */
export async function compressImage(
  base64Data: string,
  mimeType: string,
  maxDimension: number = 800,
  quality: number = 0.7
): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Calculate new dimensions preserving aspect ratio
      let width = img.naturalWidth;
      let height = img.naturalHeight;
      
      if (width > maxDimension || height > maxDimension) {
        const ratio = Math.min(maxDimension / width, maxDimension / height);
        width = Math.floor(width * ratio);
        height = Math.floor(height * ratio);
      }
      
      // Draw resized image to canvas
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      
      if (!ctx) {
        reject(new Error("Failed to get canvas context"));
        return;
      }
      
      ctx.drawImage(img, 0, 0, width, height);
      
      // Always convert to WebP for better compression
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Failed to compress image"));
            return;
          }
          
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result as string;
            // Extract base64 data (remove prefix)
            const commaIndex = dataUrl.indexOf(",");
            const base64 = dataUrl.slice(commaIndex + 1);
            resolve({ data: base64, mimeType: "image/webp" });
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        },
        "image/webp",
        quality
      );
    };
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = `data:${mimeType};base64,${base64Data}`;
  });
}

/**
 * Extracts just the base64 data from a data URL (removes prefix if present).
 */
export function extractBase64Data(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return dataUrl;
  return dataUrl.slice(commaIndex + 1);
}

/**
 * Creates an object URL from base64 data for efficient rendering.
 * This avoids embedding large base64 strings in the DOM.
 */
export function base64ToObjectUrl(base64Data: string, mimeType: string): string {
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

/**
 * Releases an object URL created by URL.createObjectURL.
 * Should be called when the image is unmounted to prevent memory leaks.
 */
export function revokeObjectUrl(url: string) {
  if (url && url.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
}

/**
 * Converts base64 image data to a blob URL in one step.
 * Helper for components that need to render images without blocking the DOM.
 * Compresses large images to WebP format.
 */
export async function base64ToRenderableUrl(
  base64Data: string,
  mimeType: string,
  maxDimension?: number,
  quality?: number
): Promise<string> {
  // Compress if needed
  const base64Length = base64Data.length;
  const estimatedSizeKB = Math.round((base64Length * 3) / 4 / 1024);
  
  const needsCompression = maxDimension && estimatedSizeKB > 500;
  
  if (needsCompression) {
    const compressed = await compressImage(base64Data, mimeType, maxDimension, quality || 0.7);
    return base64ToObjectUrl(compressed.data, compressed.mimeType);
  }
  
  return base64ToObjectUrl(base64Data, mimeType);
}

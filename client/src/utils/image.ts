/**
 * Client-side image utilities for resizing and compressing images.
 */

/**
 * Resizes and compresses a base64 image to a maximum dimension and quality.
 * Returns a compressed base64 string.
 */
export async function compressImage(
  base64Data: string,
  mimeType: string,
  maxDimension: number = 800,
  quality: number = 0.7
): Promise<string> {
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
      
      // Compress and convert back to base64
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Failed to compress image"));
            return;
          }
          
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = reader.result as string;
            // Remove data:image/...;base64, prefix
            const commaIndex = base64.indexOf(",");
            resolve(base64.slice(commaIndex + 1));
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        },
        mimeType,
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
  
  const finalBase64 = needsCompression
    ? await compressImage(base64Data, mimeType, maxDimension, quality || 0.7)
    : base64Data;
  
  return base64ToObjectUrl(finalBase64, mimeType);
}

import { useState, useCallback, useEffect, useRef } from "react";
import { fetchComfyUIStatus, fetchImageModels, fetchGeneratedImages, generateImage as apiGenerateImage } from "../api/client";
import type { ComfyUIStatus, GeneratedImage, ImageGenerationParams } from "../types";

export function useImageSandbox() {
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [selectedImage, setSelectedImage] = useState<GeneratedImage | null>(null);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ step: number; total: number } | null>(null);
  const [comfyuiStatus, setComfyuiStatus] = useState<ComfyUIStatus | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const checkStatus = useCallback(async () => {
    try {
      const status = await fetchComfyUIStatus();
      setComfyuiStatus(status);
      if (status.models.length > 0) {
        setModels(status.models);
      }
    } catch {
      setComfyuiStatus({ available: false, queueSize: 0, models: [] });
    }
  }, []);

  // Check status and load existing images on mount
  useEffect(() => {
    checkStatus();
    fetchGeneratedImages().then((existing) => {
      if (existing.length > 0) setImages(existing);
    }).catch(() => {});
  }, [checkStatus]);

  const generate = useCallback((params: ImageGenerationParams) => {
    if (generating) return;

    setGenerating(true);
    setProgress(null);
    setError(null);

    abortRef.current = apiGenerateImage(params, {
      onProgress: (step, totalSteps) => {
        setProgress({ step, total: totalSteps });
      },
      onDone: (image) => {
        setImages((prev) => [image, ...prev]);
        setSelectedImage(image);
        setGenerating(false);
        setProgress(null);
      },
      onError: (err) => {
        setError(err);
        setGenerating(false);
        setProgress(null);
      },
    });
  }, [generating]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setGenerating(false);
    setProgress(null);
  }, []);

  return {
    images,
    selectedImage,
    setSelectedImage,
    generating,
    progress,
    comfyuiStatus,
    models,
    error,
    generate,
    abort,
    checkStatus,
  };
}

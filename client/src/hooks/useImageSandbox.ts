import { useState, useCallback, useEffect, useRef } from "react";
import { fetchComfyUIStatus, fetchGeneratedImages, generateImage as apiGenerateImage } from "../api/client";
import type { ComfyUIStatus, GeneratedImage, ImageGenerationParams } from "../types";

export interface QueueItem {
  id: string;
  params: ImageGenerationParams;
  batchIndex: number;
  batchTotal: number;
  promptPreview: string;
}

export function useImageSandbox() {
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [selectedImage, setSelectedImage] = useState<GeneratedImage | null>(null);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ step: number; total: number } | null>(null);
  const [comfyuiStatus, setComfyuiStatus] = useState<ComfyUIStatus | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [currentItem, setCurrentItem] = useState<QueueItem | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const processingRef = useRef(false);

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

  // Process queue: pick next item when not generating
  useEffect(() => {
    if (processingRef.current || queue.length === 0) return;
    processingRef.current = true;

    const [next, ...rest] = queue;
    setQueue(rest);
    setCurrentItem(next);
    setGenerating(true);
    setProgress(null);
    setError(null);

    abortRef.current = apiGenerateImage(next.params, {
      onProgress: (step, totalSteps) => {
        setProgress({ step, total: totalSteps });
      },
      onDone: (image) => {
        setImages((prev) => [image, ...prev]);
        setSelectedImage(image);
        setGenerating(false);
        setProgress(null);
        setCurrentItem(null);
        processingRef.current = false;
      },
      onError: (err) => {
        setError(err);
        setGenerating(false);
        setProgress(null);
        setCurrentItem(null);
        processingRef.current = false;
      },
    });
  }, [queue, generating]);

  const enqueue = useCallback((params: ImageGenerationParams, batchCount: number = 1) => {
    const batchId = crypto.randomUUID().slice(0, 8);
    const preview = params.positivePrompt.slice(0, 60) + (params.positivePrompt.length > 60 ? "..." : "");
    const items: QueueItem[] = Array.from({ length: batchCount }, (_, i) => ({
      id: `${batchId}-${i}`,
      params: { ...params, seed: undefined },
      batchIndex: i + 1,
      batchTotal: batchCount,
      promptPreview: preview,
    }));
    setQueue((prev) => [...prev, ...items]);
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setGenerating(false);
    setProgress(null);
    setCurrentItem(null);
    processingRef.current = false;
  }, []);

  const clearQueue = useCallback(() => {
    setQueue([]);
  }, []);

  const abortAll = useCallback(() => {
    abort();
    clearQueue();
  }, [abort, clearQueue]);

  return {
    images,
    selectedImage,
    setSelectedImage,
    generating,
    progress,
    comfyuiStatus,
    models,
    error,
    enqueue,
    abort,
    abortAll,
    clearQueue,
    queue,
    currentItem,
    checkStatus,
  };
}

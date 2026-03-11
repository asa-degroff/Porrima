import { useState, useCallback, useEffect, useRef } from "react";
import {
  fetchComfyUIStatus,
  fetchGeneratedImages,
  generateImage as apiGenerateImage,
  deleteGeneratedImage as apiDeleteImage,
  fetchGenerations,
  subscribeToGeneration,
} from "../api/client";
import type { ComfyUIStatus, GeneratedImage, ImageGenerationParams, GenerationState } from "../types";

export interface QueueItem {
  id: string;
  params: ImageGenerationParams;
  batchIndex: number;
  batchTotal: number;
  promptPreview: string;
}

// Check if a generation is actively running
function isActiveGeneration(gen: GenerationState): boolean {
  return gen.status === "queued" || gen.status === "processing";
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
  const [activeGenerationId, setActiveGenerationId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const processingRef = useRef(false);
  const subscribedGenerationId = useRef<string | null>(null);

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

  // Subscribe to a generation's SSE stream
  const subscribeToGenerationEvents = useCallback((generationId: string) => {
    if (subscribedGenerationId.current === generationId) return;

    subscribedGenerationId.current = generationId;
    const abortController = subscribeToGeneration(generationId, {
      onState: (state) => {
        if (state.status === "processing" && state.progress) {
          setGenerating(true);
          setProgress({ step: state.progress.step, total: state.progress.total });
          setActiveGenerationId(generationId);
          setError(null);
        } else if (state.status === "completed" && state.imageUrl) {
          setGenerating(false);
          setProgress(null);
          setActiveGenerationId(null);
          subscribedGenerationId.current = null;
          processingRef.current = false;
          // The image will appear in the list after refresh
        } else if (state.status === "error") {
          setGenerating(false);
          setProgress(null);
          setActiveGenerationId(null);
          subscribedGenerationId.current = null;
          processingRef.current = false;
          setError(state.error || "Generation failed");
        }
      },
      onError: (err) => {
        setError(err);
        setGenerating(false);
        setProgress(null);
        setActiveGenerationId(null);
        subscribedGenerationId.current = null;
        processingRef.current = false;
      },
    });
    abortRef.current = abortController;
  }, []);

  // Check status, load images, and recover active generations on mount
  useEffect(() => {
    checkStatus();
    fetchGeneratedImages().then((existing) => {
      if (existing.length > 0) setImages(existing);
    }).catch(() => {});

    // Check for any active generations to recover
    fetchGenerations().then((generations) => {
      const active = generations.find(isActiveGeneration);
      if (active) {
        console.log("[image-sandbox] recovering active generation:", active.id);
        subscribeToGenerationEvents(active.id);
      }
    }).catch(() => {});
  }, [checkStatus, subscribeToGenerationEvents]);

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
      onStarted: (generationId) => {
        setActiveGenerationId(generationId);
        subscribeToGenerationEvents(generationId);
      },
      onProgress: (step, totalSteps) => {
        setProgress({ step, total: totalSteps });
      },
      onDone: (image) => {
        setImages((prev) => [image, ...prev]);
        setSelectedImage(image);
        setGenerating(false);
        setProgress(null);
        setCurrentItem(null);
        setActiveGenerationId(null);
        subscribedGenerationId.current = null;
        processingRef.current = false;
      },
      onError: (err) => {
        setError(err);
        setGenerating(false);
        setProgress(null);
        setCurrentItem(null);
        setActiveGenerationId(null);
        subscribedGenerationId.current = null;
        processingRef.current = false;
      },
    });
  }, [queue, generating, subscribeToGenerationEvents]);

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

  const deleteImage = useCallback(async (id: string) => {
    try {
      await apiDeleteImage(id);
      setImages((prev) => prev.filter((img) => img.id !== id));
      if (selectedImage?.id === id) {
        setSelectedImage(null);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, [selectedImage]);

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
    deleteImage,
    queue,
    currentItem,
    checkStatus,
  };
}

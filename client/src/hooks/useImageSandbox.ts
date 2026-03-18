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
  const [activeGenerations, setActiveGenerations] = useState<GenerationState[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const subscribedGenerationIds = useRef<Set<string>>(new Set());
  const statusPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Subscribe to a generation's SSE stream
  const subscribeToGenerationEvents = useCallback((generationId: string) => {
    if (subscribedGenerationIds.current.has(generationId)) return;

    subscribedGenerationIds.current.add(generationId);
    const abortController = subscribeToGeneration(generationId, {
      onState: (state) => {
        // Update active generations list with latest state
        setActiveGenerations((prev) => {
          const idx = prev.findIndex((g) => g.id === state.id);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = state;
            return copy;
          }
          return prev;
        });

        // Update UI state for the primary generation display
        if (state.status === "processing" && state.progress) {
          setGenerating(true);
          setProgress({ step: state.progress.step, total: state.progress.total });
          setError(null);
        } else if (state.status === "completed" && state.imageUrl) {
          setGenerating(false);
          setProgress(null);
          setError(null); // Clear error on success
          subscribedGenerationIds.current.delete(generationId);
          // The image will appear in the list after refresh
        } else if (state.status === "error") {
          setGenerating(false);
          setProgress(null);
          subscribedGenerationIds.current.delete(generationId);
          setError(state.error || "Generation failed");
        }
      },
      onError: (err) => {
        setError(err);
        setGenerating(false);
        setProgress(null);
        subscribedGenerationIds.current.delete(generationId);
      },
    });
    abortRef.current = abortController;
  }, []);

  // Poll ComfyUI status continuously (every 10 seconds)
  useEffect(() => {
    const pollStatus = async () => {
      try {
        const status = await fetchComfyUIStatus();
        setComfyuiStatus(status);
        if (status.models.length > 0) {
          setModels(status.models);
        }
      } catch {
        setComfyuiStatus({ available: false, queueSize: 0, models: [] });
      }
    };

    // Initial poll
    pollStatus();

    // Poll every 10 seconds while component is mounted
    statusPollingRef.current = setInterval(pollStatus, 10000);

    return () => {
      if (statusPollingRef.current) {
        clearInterval(statusPollingRef.current);
      }
    };
  }, []);

  // Load images and recover active generations on mount
  useEffect(() => {
    fetchGeneratedImages().then((existing) => {
      if (existing.length > 0) setImages(existing);
    }).catch(() => {});

    // Check for any active generations to recover
    fetchGenerations().then((generations) => {
      const active = generations.filter(isActiveGeneration);
      if (active.length > 0) {
        console.log(`[image-sandbox] recovering ${active.length} active generation(s)`);
        setActiveGenerations(active);
        // Subscribe to all active generations
        active.forEach((gen) => subscribeToGenerationEvents(gen.id));
      }
    }).catch(() => {});
  }, [subscribeToGenerationEvents]);

  // Refresh active generations list periodically
  useEffect(() => {
    const refreshInterval = setInterval(() => {
      fetchGenerations().then((generations) => {
        const active = generations.filter(isActiveGeneration);
        setActiveGenerations(active);
      }).catch(() => {});
    }, 2000);

    return () => clearInterval(refreshInterval);
  }, []);

  const enqueue = useCallback(async (params: ImageGenerationParams, batchCount: number = 1) => {
    // Clear any previous error state when starting new generation
    setError(null);
    
    // Enqueue by creating generation states on the server
    // Each batch item becomes a separate generation
    for (let i = 0; i < batchCount; i++) {
      const genParams: ImageGenerationParams = { ...params, seed: undefined };
      // This will create a new generation and start it immediately
      // The server handles queuing via generations.json state
      let currentGenerationId: string | null = null;
      abortRef.current = apiGenerateImage(genParams, {
        onStarted: (generationId) => {
          currentGenerationId = generationId;
          subscribeToGenerationEvents(generationId);
        },
        onProgress: (step, totalSteps) => {
          setProgress({ step, total: totalSteps });
        },
        onDone: (image) => {
          // Refresh from server to ensure authoritative list
          fetchGeneratedImages().then((fresh) => {
            setImages(fresh);
            // Ensure the newly generated image is selected
            const justCreated = fresh.find((img) => img.id === image.id);
            if (justCreated) {
              setSelectedImage(justCreated);
            }
          }).catch(() => {
            // Fallback to local state update
            setImages((prev) => {
              if (prev.some((img) => img.id === image.id)) {
                return prev;
              }
              return [image, ...prev];
            });
            setSelectedImage(image);
          });
          setGenerating(false);
          setProgress(null);
          setError(null); // Clear error on success
          if (currentGenerationId) {
            subscribedGenerationIds.current.delete(currentGenerationId);
          }
        },
        onError: (err) => {
          setError(err);
          setGenerating(false);
          setProgress(null);
          if (currentGenerationId) {
            subscribedGenerationIds.current.delete(currentGenerationId);
          }
        },
      });
    }
  }, [subscribeToGenerationEvents]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setGenerating(false);
    setProgress(null);
  }, []);

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
    deleteImage,
    activeGenerations,
  };
}

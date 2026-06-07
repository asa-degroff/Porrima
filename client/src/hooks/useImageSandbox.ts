import { useState, useCallback, useEffect, useRef } from "react";
import {
  fetchComfyUIStatus,
  fetchGeneratedImages,
  generateImage as apiGenerateImage,
  deleteGeneratedImage as apiDeleteImage,
  fetchGenerations,
  subscribeToGeneration,
  toggleImageFavorite as apiToggleImageFavorite,
} from "../api/client";
import type { CoordinatorStatus } from "../api/client";
import type { ComfyUIStatus, GeneratedImage, ImageGenerationParams, GenerationState } from "../types";

// Check if a generation is actively running
function isActiveGeneration(gen: GenerationState): boolean {
  return gen.status === "queued" || gen.status === "processing";
}

function isOptimisticGeneration(gen: GenerationState): boolean {
  return gen.id.startsWith("optimistic-");
}

function normalizeActiveGenerations(generations: GenerationState[]): GenerationState[] {
  const unique = new Map<string, GenerationState>();
  for (const gen of generations) {
    if (isActiveGeneration(gen)) unique.set(gen.id, gen);
  }
  return Array.from(unique.values()).sort((a, b) => b.createdAt - a.createdAt);
}

function reconcilePolledGenerations(
  current: GenerationState[],
  polled: GenerationState[]
): GenerationState[] {
  const pendingOptimistic = current.filter((gen) => isOptimisticGeneration(gen) && isActiveGeneration(gen));
  return normalizeActiveGenerations([...polled, ...pendingOptimistic]);
}

function upsertActiveGeneration(
  current: GenerationState[],
  generation: GenerationState
): GenerationState[] {
  const withoutGeneration = current.filter((gen) => gen.id !== generation.id);
  return normalizeActiveGenerations([...withoutGeneration, generation]);
}

export function useImageSandbox() {
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [selectedImage, setSelectedImage] = useState<GeneratedImage | null>(null);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ step: number; total: number } | null>(null);
  const [comfyuiStatus, setComfyuiStatus] = useState<ComfyUIStatus | null>(null);
  const [coordinatorStatus, setCoordinatorStatus] = useState<CoordinatorStatus | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeGenerations, setActiveGenerations] = useState<GenerationState[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const subscribedGenerationIds = useRef<Set<string>>(new Set());
  const statusPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const errorDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-dismiss error after 5 seconds of successful operations
  const scheduleErrorDismiss = useCallback(() => {
    if (errorDismissTimer.current) clearTimeout(errorDismissTimer.current);
    errorDismissTimer.current = setTimeout(() => {
      setError(null);
    }, 5000);
  }, []);

  // Subscribe to a generation's SSE stream
  const subscribeToGenerationEvents = useCallback((generationId: string) => {
    if (subscribedGenerationIds.current.has(generationId)) return;

    subscribedGenerationIds.current.add(generationId);
    const abortController = subscribeToGeneration(generationId, {
      onState: (state) => {
        // Update active generations list with latest state
        setActiveGenerations((prev) => upsertActiveGeneration(prev, state));

        // Update UI state for the primary generation display
        if (state.status === "processing" && state.progress) {
          setGenerating(true);
          setProgress({ step: state.progress.step, total: state.progress.total });
          setError(null);
        } else if (state.status === "completed" && state.imageUrl) {
          setGenerating(false);
          setProgress(null);
          setError(null);
          setActiveGenerations((prev) => prev.filter((gen) => gen.id !== state.id));
          subscribedGenerationIds.current.delete(generationId);
          // Schedule error dismiss to clear any transient errors
          scheduleErrorDismiss();
          // Refresh image list so newly completed images appear in gallery
          fetchGeneratedImages().then((fresh) => {
            if (fresh.length > 0) setImages(fresh);
          }).catch(() => {});
        } else if (state.status === "error") {
          setGenerating(false);
          setProgress(null);
          setActiveGenerations((prev) => prev.filter((gen) => gen.id !== state.id));
          subscribedGenerationIds.current.delete(generationId);
          setError(state.error || "Generation failed");
        }
      },
      onError: (err) => {
        setError(err);
        setGenerating(false);
        setProgress(null);
        setActiveGenerations((prev) => prev.filter((gen) => gen.id !== generationId));
        subscribedGenerationIds.current.delete(generationId);
      },
    });
    abortRef.current = abortController;
  }, [scheduleErrorDismiss]);

  // Listen for corpus image generation events and refresh gallery
  useEffect(() => {
    const handleCorpusGeneration = () => {
      console.log("[useImageSandbox] Corpus image generated, refreshing gallery");
      fetchGeneratedImages().then((fresh) => {
        if (fresh.length > 0) setImages(fresh);
      }).catch(() => {});
    };

    window.addEventListener('corpus-image-generated', handleCorpusGeneration);
    return () => window.removeEventListener('corpus-image-generated', handleCorpusGeneration);
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
        // Clear error if ComfyUI is available and we're not actively generating
        if (status.available && !generating) {
          setError(null);
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
  }, [generating]);

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
        setActiveGenerations(normalizeActiveGenerations(active));
        // Subscribe to all active generations, but validate they still exist first
        active.forEach((gen) => {
          // Only subscribe if generation is truly active (not stale from server restart)
          if (gen.status === "queued" || gen.status === "processing") {
            subscribeToGenerationEvents(gen.id);
          }
        });
      }
    }).catch(() => {});
  }, [subscribeToGenerationEvents]);

  // Refresh active generations list periodically
  useEffect(() => {
    const refreshInterval = setInterval(() => {
      fetchGenerations().then((generations) => {
        const active = generations.filter(isActiveGeneration);
        setActiveGenerations((prev) => reconcilePolledGenerations(prev, active));
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
      
      // Create optimistic generation state for immediate visual feedback
      const optimisticId = `optimistic-${Date.now()}-${i}`;
      const optimisticCreatedAt = Date.now();
      const optimisticGen: GenerationState = {
        id: optimisticId,
        clientId: "",
        params: genParams,
        status: "queued",
        progress: null,
        createdAt: optimisticCreatedAt,
        updatedAt: optimisticCreatedAt,
      };
      
      // Add to active generations immediately for visual feedback
      setActiveGenerations((prev) => upsertActiveGeneration(prev, optimisticGen));
      
      // This will create a new generation and start it immediately
      // The server handles queuing via generations.json state
      let currentGenerationId: string | null = null;
      abortRef.current = apiGenerateImage(genParams, {
        onStarted: (generationId) => {
          currentGenerationId = generationId;
          subscribeToGenerationEvents(generationId);
          
          // Replace the optimistic row in-place with the real server id so the
          // gallery never renders an empty frame between the two SSE streams.
          setActiveGenerations((prev) => {
            const existing = prev.find((g) => g.id === optimisticId);
            const realQueuedGeneration: GenerationState = {
              id: generationId,
              clientId: "",
              params: existing?.params ?? genParams,
              status: existing?.status ?? "queued",
              progress: existing?.progress ?? null,
              createdAt: existing?.createdAt ?? optimisticCreatedAt,
              updatedAt: Date.now(),
            };
            return upsertActiveGeneration(
              prev.filter((g) => g.id !== optimisticId),
              realQueuedGeneration
            );
          });
        },
        onProgress: (step, totalSteps) => {
          setProgress({ step, total: totalSteps });
          if (currentGenerationId) {
            const generationId = currentGenerationId;
            setActiveGenerations((prev) => {
              const existing = prev.find((g) => g.id === generationId);
              return upsertActiveGeneration(prev, {
                id: generationId,
                clientId: existing?.clientId ?? "",
                params: existing?.params ?? genParams,
                status: "processing",
                progress: { step, total: totalSteps },
                createdAt: existing?.createdAt ?? optimisticCreatedAt,
                updatedAt: Date.now(),
              });
            });
          }
          // Clear coordinator status once real progress starts — coordination
          // is done, the model is generating.
          setCoordinatorStatus(null);
          // Clear error on progress - generation is actively running
          setError(null);
        },
        onStatus: (status) => {
          // "ready" is the terminal coordinator phase; don't pin it visibly
          // since the progress stream takes over immediately after.
          setCoordinatorStatus(status.phase === "ready" ? null : status);
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
          setCoordinatorStatus(null);
          setActiveGenerations((prev) => prev.filter((gen) => (
            gen.id !== optimisticId && gen.id !== currentGenerationId
          )));
          setError(null); // Clear error on success
          scheduleErrorDismiss(); // Ensure error stays cleared
          if (currentGenerationId) {
            subscribedGenerationIds.current.delete(currentGenerationId);
          }
        },
        onError: (err) => {
          setError(err);
          setGenerating(false);
          setProgress(null);
          setCoordinatorStatus(null);
          setActiveGenerations((prev) => prev.filter((gen) => (
            gen.id !== optimisticId && gen.id !== currentGenerationId
          )));
          if (currentGenerationId) {
            subscribedGenerationIds.current.delete(currentGenerationId);
          }
        },
      });
    }
  }, [subscribeToGenerationEvents, scheduleErrorDismiss]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setGenerating(false);
    setProgress(null);
    // Clear error on manual abort - user initiated the cancellation
    setError(null);
  }, []);

  const deleteImage = useCallback(async (id: string) => {
    try {
      await apiDeleteImage(id);
      setImages((prev) => prev.filter((img) => img.id !== id));
      if (selectedImage?.id === id) {
        setSelectedImage(null);
      }
      // Clear error on successful delete
      setError(null);
      
      // Trigger corpus stats refresh (if CorpusView is listening)
      window.dispatchEvent(new CustomEvent('corpus-image-deleted'));
    } catch (e: any) {
      setError(e.message);
    }
  }, [selectedImage]);

  const toggleFavorite = useCallback(async (id: string) => {
    try {
      const newFavoriteState = await apiToggleImageFavorite(id);
      // Update the local image's favorite status
      setImages((prev) => prev.map((img) => 
        img.id === id ? { ...img, isFavorite: newFavoriteState } : img
      ));
      // Update selected image if it's the one being toggled
      if (selectedImage?.id === id) {
        setSelectedImage({ ...selectedImage, isFavorite: newFavoriteState });
      }
      // Clear any errors on success
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [selectedImage]);

  // Clear error when selecting a different image
  const handleSetSelectedImage = useCallback((image: GeneratedImage | null) => {
    setSelectedImage(image);
    if (image) {
      setError(null);
    }
  }, []);

  // Clear error dismiss timer on unmount
  useEffect(() => {
    return () => {
      if (errorDismissTimer.current) clearTimeout(errorDismissTimer.current);
    };
  }, []);

  return {
    images,
    selectedImage,
    setSelectedImage: handleSetSelectedImage,
    generating,
    progress,
    comfyuiStatus,
    coordinatorStatus,
    models,
    error,
    enqueue,
    abort,
    deleteImage,
    toggleFavorite,
    activeGenerations,
  };
}

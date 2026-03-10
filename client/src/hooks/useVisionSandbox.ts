import { useState, useCallback, useEffect, useRef } from "react";
import {
  fetchVisionPresets,
  fetchAnalyzedImages,
  fetchAnalyzedImage,
  analyzeImage as apiAnalyzeImage,
  saveAnalyzedImage as apiSaveAnalyzedImage,
  streamAnalyzeImage,
  chatAboutImage as apiChatAboutImage,
  reanalyzeImage as apiReanalyzeImage,
  streamReanalyzeImage,
  deleteAnalyzedImage as apiDeleteAnalyzedImage,
  type VisionPreset,
  type AnalyzedImage,
  type VisionMessage,
} from "../api/client";

export function useVisionSandbox() {
  const [presets, setPresets] = useState<VisionPreset[]>([]);
  const [analyzedImages, setAnalyzedImages] = useState<AnalyzedImage[]>([]);
  const [selectedImage, setSelectedImage] = useState<AnalyzedImage | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [chatting, setChatting] = useState(false);
  const [streamingDescription, setStreamingDescription] = useState<string | null>(null);
  const [pendingImageData, setPendingImageData] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Cache fetched images so switching back is instant
  const imageCacheRef = useRef(new Map<string, AnalyzedImage>());

  // Load presets and images on mount
  useEffect(() => {
    async function load() {
      try {
        const [presetsData, imagesData] = await Promise.all([
          fetchVisionPresets(),
          fetchAnalyzedImages(),
        ]);
        setPresets(presetsData);
        setAnalyzedImages(imagesData);
      } catch (e: any) {
        setError(e.message);
      }
    }
    load();
  }, []);

  const analyzeImage = useCallback(async (imageData: string, preset: string, model?: string) => {
    setAnalyzing(true);
    setStreamingDescription("");
    setPendingImageData(imageData);
    setError(null);
    try {
      return await new Promise<AnalyzedImage>((resolve, reject) => {
        const controller = streamAnalyzeImage(imageData, preset, model, {
          onDelta: (delta) => {
            setStreamingDescription((prev) => (prev ?? "") + delta);
          },
          onDone: async (result) => {
            // Save the image with the already-completed description (no re-analysis)
            const saved = await apiSaveAnalyzedImage(imageData, result.description, result.preset, result.model);
            setAnalyzedImages((prev) => [saved, ...prev]);
            const updated = saved;
            setSelectedImage(updated);
            setStreamingDescription(null);
            setPendingImageData(null);
            setAnalyzing(false);
            resolve(updated);
          },
          onError: (err) => {
            setError(err);
            setStreamingDescription(null);
            setPendingImageData(null);
            setAnalyzing(false);
            reject(new Error(err));
          },
        });
      });
    } catch (e: any) {
      setError(e.message);
      setAnalyzing(false);
      throw e;
    }
  }, []);

  const chatAboutImage = useCallback(async (id: string, message: string) => {
    setChatting(true);
    setError(null);
    try {
      const result = await apiChatAboutImage(id, message);
      
      // Update local state with new message
      setAnalyzedImages((prev) =>
        prev.map((img) => {
          if (img.id === id) {
            const newConversation: VisionMessage[] = [
              ...img.conversation,
              { role: "user", content: message, timestamp: Date.now() },
              { role: "assistant", content: result.response, timestamp: Date.now() },
            ];
            return { ...img, conversation: newConversation };
          }
          return img;
        })
      );

      // Update selected image and cache if it's the current one
      setSelectedImage((prev) => {
        if (!prev || prev.id !== id) return prev;
        const newConversation: VisionMessage[] = [
          ...prev.conversation,
          { role: "user", content: message, timestamp: Date.now() },
          { role: "assistant", content: result.response, timestamp: Date.now() },
        ];
        const updated = { ...prev, conversation: newConversation };
        imageCacheRef.current.set(id, updated);
        return updated;
      });

      return result.response;
    } catch (e: any) {
      setError(e.message);
      throw e;
    } finally {
      setChatting(false);
    }
  }, []);

  const reanalyzeImage = useCallback(async (id: string, preset: string) => {
    setAnalyzing(true);
    setStreamingDescription("");
    setError(null);
    try {
      return await new Promise<AnalyzedImage>((resolve, reject) => {
        streamReanalyzeImage(id, preset, {
          onDelta: (delta) => {
            setStreamingDescription((prev) => (prev ?? "") + delta);
          },
          onDone: (result) => {
            setAnalyzedImages((prev) =>
              prev.map((img) => (img.id === id ? result : img))
            );
            imageCacheRef.current.delete(id);
            setSelectedImage(result);
            setStreamingDescription(null);
            setAnalyzing(false);
            resolve(result);
          },
          onError: (err) => {
            setError(err);
            setStreamingDescription(null);
            setAnalyzing(false);
            reject(new Error(err));
          },
        });
      });
    } catch (e: any) {
      setError(e.message);
      setAnalyzing(false);
      throw e;
    }
  }, []);

  const deleteImage = useCallback(async (id: string) => {
    setError(null);
    try {
      await apiDeleteAnalyzedImage(id);
      imageCacheRef.current.delete(id);
      setAnalyzedImages((prev) => prev.filter((img) => img.id !== id));
      if (selectedImage?.id === id) {
        setSelectedImage(null);
      }
    } catch (e: any) {
      setError(e.message);
      throw e;
    }
  }, [selectedImage]);

  const selectImage = useCallback(async (id: string) => {
    const cached = imageCacheRef.current.get(id);
    if (cached) {
      setSelectedImage(cached);
      return;
    }
    try {
      const image = await fetchAnalyzedImage(id);
      imageCacheRef.current.set(id, image);
      setSelectedImage(image);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const refreshImages = useCallback(async () => {
    try {
      const images = await fetchAnalyzedImages();
      setAnalyzedImages(images);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  return {
    presets,
    analyzedImages,
    selectedImage,
    analyzing,
    chatting,
    streamingDescription,
    pendingImageData,
    error,
    analyzeImage,
    chatAboutImage,
    reanalyzeImage,
    deleteImage,
    selectImage,
    setSelectedImage,
    refreshImages,
  };
}

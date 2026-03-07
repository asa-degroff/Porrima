import { useState, useCallback, useEffect, useRef } from "react";
import {
  fetchVisionPresets,
  fetchAnalyzedImages,
  fetchAnalyzedImage,
  analyzeImage as apiAnalyzeImage,
  chatAboutImage as apiChatAboutImage,
  reanalyzeImage as apiReanalyzeImage,
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
    setError(null);
    try {
      const result = await apiAnalyzeImage(imageData, preset, model);
      setAnalyzedImages((prev) => [result, ...prev]);
      setSelectedImage(result);
      return result;
    } catch (e: any) {
      setError(e.message);
      throw e;
    } finally {
      setAnalyzing(false);
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
    setError(null);
    try {
      const result = await apiReanalyzeImage(id, preset);
      
      setAnalyzedImages((prev) =>
        prev.map((img) => (img.id === id ? result : img))
      );
      
      // Invalidate cache — re-analyze changes description and resets conversation
      imageCacheRef.current.delete(id);

      if (selectedImage?.id === id) {
        setSelectedImage(result);
      }

      return result;
    } catch (e: any) {
      setError(e.message);
      throw e;
    } finally {
      setAnalyzing(false);
    }
  }, [selectedImage]);

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

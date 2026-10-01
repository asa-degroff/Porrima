export interface ExtractionPromptStore {
  content: string;
  lastModified: string | null;
  path?: string;
}

export async function getExtractionPrompt(): Promise<ExtractionPromptStore> {
  const res = await fetch("/api/extraction-prompt", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch extraction prompt");
  return res.json();
}

export async function updateExtractionPrompt(content: string, reason?: string): Promise<ExtractionPromptStore> {
  const res = await fetch("/api/extraction-prompt", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, reason }),
  });
  if (!res.ok) throw new Error("Failed to update extraction prompt");
  return res.json();
}


export interface ExtractionPromptStore {
  content: string;
  lastModified: string | null;
  path?: string;
}

export interface ExtractionPromptVersion {
  filename: string;
  content: string;
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

export async function getExtractionPromptHistory(): Promise<{ versions: string[] }> {
  const res = await fetch("/api/extraction-prompt/history", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch extraction prompt history");
  return res.json();
}

export async function getExtractionPromptVersion(filename: string): Promise<ExtractionPromptVersion> {
  const res = await fetch(`/api/extraction-prompt/history/${encodeURIComponent(filename)}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch extraction prompt version");
  return res.json();
}

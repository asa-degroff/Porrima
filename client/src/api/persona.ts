export interface PersonaStore {
  content: string;
  lastModified: string | null;
  path?: string;
}

export interface PersonaVersion {
  filename: string;
  content: string;
}

export async function getPersona(): Promise<PersonaStore> {
  const res = await fetch("/api/persona", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch persona");
  return res.json();
}

export async function updatePersona(content: string, reason?: string): Promise<PersonaStore> {
  const res = await fetch("/api/persona", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, reason }),
  });
  if (!res.ok) throw new Error("Failed to update persona");
  return res.json();
}

export async function getPersonaHistory(): Promise<{ versions: string[] }> {
  const res = await fetch("/api/persona/history", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch persona history");
  return res.json();
}

export async function getPersonaVersion(filename: string): Promise<PersonaVersion> {
  const res = await fetch(`/api/persona/history/${encodeURIComponent(filename)}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch persona version");
  return res.json();
}

export interface UserDocument {
  content: string;
  lastModified: string | null;
  path?: string;
}

export async function getUserDocument(): Promise<UserDocument | null> {
  const res = await fetch("/api/user", { credentials: "include" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to fetch user document");
  return res.json();
}

export async function updateUserDocument(content: string): Promise<UserDocument> {
  const res = await fetch("/api/user", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error("Failed to save user document");
  return res.json();
}

export async function deleteUserDocument(): Promise<void> {
  const res = await fetch("/api/user", {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to delete user document");
}

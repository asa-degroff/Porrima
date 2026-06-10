const BASE = "/api/auth";

export interface AuthStatus {
  authenticated: boolean;
  setupComplete: boolean;
  setupTokenRequired?: boolean;
}

const setupTokenHeader = "X-Porrima-Setup-Token";

function withSetupTokenHeader(setupToken?: string): HeadersInit | undefined {
  const token = setupToken?.trim();
  return token ? { [setupTokenHeader]: token } : undefined;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(`${BASE}/status`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch auth status");
  return res.json();
}

export async function fetchRegisterOptions(setupToken?: string): Promise<any> {
  const res = await fetch(`${BASE}/register/options`, {
    method: "POST",
    headers: withSetupTokenHeader(setupToken),
    credentials: "include",
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to get registration options");
  }
  return res.json();
}

export async function verifyRegistration(
  response: any,
  setupToken?: string
): Promise<{ verified: boolean }> {
  const res = await fetch(`${BASE}/register/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...withSetupTokenHeader(setupToken),
    },
    credentials: "include",
    body: JSON.stringify(response),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Registration verification failed");
  }
  return res.json();
}

export async function fetchLoginOptions(): Promise<any> {
  const res = await fetch(`${BASE}/login/options`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to get login options");
  }
  return res.json();
}

export async function verifyLogin(response: any): Promise<{ verified: boolean }> {
  const res = await fetch(`${BASE}/login/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(response),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Login verification failed");
  }
  return res.json();
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/logout`, {
    method: "POST",
    credentials: "include",
  });
}

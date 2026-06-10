import { useState, useEffect, useCallback } from "react";
// @simplewebauthn/browser is dynamically imported in register/login
import {
  fetchAuthStatus,
  fetchRegisterOptions,
  verifyRegistration,
  fetchLoginOptions,
  verifyLogin,
  logout as apiLogout,
} from "../api/auth";

export type AuthState = "loading" | "needs-setup" | "needs-login" | "authenticated";

export function useAuth() {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [error, setError] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    try {
      const status = await fetchAuthStatus();
      if (status.authenticated) {
        setAuthState("authenticated");
      } else if (!status.setupComplete) {
        setAuthState("needs-setup");
      } else {
        setAuthState("needs-login");
      }
    } catch {
      setAuthState("needs-login");
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // Listen for 401 events from apiFetch
  useEffect(() => {
    const handler = () => {
      setAuthState("needs-login");
    };
    window.addEventListener("auth:unauthorized", handler);
    return () => window.removeEventListener("auth:unauthorized", handler);
  }, []);

  const register = useCallback(async (setupToken?: string) => {
    setError(null);
    try {
      const token = setupToken?.trim();
      const options = await fetchRegisterOptions(token);
      const { startRegistration } = await import("@simplewebauthn/browser");
      const response = await startRegistration({ optionsJSON: options });
      const result = await verifyRegistration(response, token);
      if (result.verified) {
        setAuthState("authenticated");
      }
    } catch (err: any) {
      setError(err.message || "Registration failed");
    }
  }, []);

  const login = useCallback(async () => {
    setError(null);
    try {
      const options = await fetchLoginOptions();
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const response = await startAuthentication({ optionsJSON: options });
      const result = await verifyLogin(response);
      if (result.verified) {
        setAuthState("authenticated");
      }
    } catch (err: any) {
      setError(err.message || "Login failed");
    }
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setAuthState("needs-login");
  }, []);

  return { authState, error, register, login, logout };
}

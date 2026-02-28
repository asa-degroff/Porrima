import { lazy, Suspense } from "react";
import type { AuthState } from "../hooks/useAuth";

const RippleGridBackground = lazy(() =>
  import("./RippleGridBackground").then((m) => ({ default: m.RippleGridBackground }))
);

interface Props {
  authState: "needs-setup" | "needs-login";
  error: string | null;
  onRegister: () => void;
  onLogin: () => void;
}

export function LoginPage({ authState, error, onRegister, onLogin }: Props) {
  const isSetup = authState === "needs-setup";

  return (
    <div className="flex items-center justify-center h-screen relative">
      <Suspense fallback={null}>
        <RippleGridBackground />
      </Suspense>
      <div className="relative z-10 backdrop-blur-xl bg-white/[0.08] border border-white/10 rounded-2xl p-8 max-w-sm w-full mx-4 text-center">
        <h1 className="text-2xl font-semibold text-white/90 tracking-tight mb-2">
          {isSetup ? "Welcome to qu.je" : "qu.je"}
        </h1>
        <p className="text-sm text-white/40 mb-6">
          {isSetup
            ? "Set up your passkey to get started"
            : "Sign in to continue"}
        </p>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-xl bg-red-500/10 border border-red-400/20 text-red-300 text-sm">
            {error}
          </div>
        )}

        <button
          onClick={isSetup ? onRegister : onLogin}
          className="w-full px-4 py-3 rounded-xl bg-purple-500/20 border border-purple-400/30 text-purple-200 font-medium hover:bg-purple-500/30 transition-all flex items-center justify-center gap-2"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z" />
            <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
          </svg>
          {isSetup ? "Register Passkey" : "Sign in with Passkey"}
        </button>
      </div>
    </div>
  );
}

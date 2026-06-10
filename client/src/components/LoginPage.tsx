import { lazy, Suspense, useState, type FormEvent } from "react";
import type { AuthState } from "../hooks/useAuth";
import type { CornerShape } from "../types";
import { OctahedronLogo } from "./PolyhedronLogo";

const RippleDotsBackground = lazy(() =>
  import("./RippleDotsBackground").then((m) => ({ default: m.RippleDotsBackground }))
);

interface Props {
  authState: "needs-setup" | "needs-login";
  error: string | null;
  onRegister: (setupToken?: string) => void;
  onLogin: () => void;
  agentName?: string;
  cornerShape?: CornerShape;
}

export function LoginPage({ authState, error, onRegister, onLogin, agentName, cornerShape = 'round' }: Props) {
  const isSetup = authState === "needs-setup";
  const cornerClass = cornerShape === 'squircle' ? 'corner-squircle' : 'corner-round';
  const [setupToken, setSetupToken] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSetup) {
      onRegister(setupToken);
    } else {
      onLogin();
    }
  };

  return (
    <div className="flex flex-col md:flex-row items-center justify-center gap-6 h-full relative">
      <Suspense fallback={null}>
        <RippleDotsBackground />
      </Suspense>
      {/* Edge shadow vignette */}
      <div className="absolute inset-0 pointer-events-none z-10 shadow-[inset_0_16px_80px_-16px_rgba(0,0,0,0.35),inset_0px_-16px_80px_-16px_rgba(0,0,0,0.35)]" />
      {/* Octahedron grid */}
      <div className="flex justify-center">
        <OctahedronLogo isActive count={8} size={64} gap={8} cols={4} speed={0.5} />
      </div>
      <div className={`relative z-10 backdrop-blur-xl bg-white/[0.08] border border-white/10 rounded-2xl ${cornerClass} px-6 py-5 max-w-sm w-full mx-4`}>

        {error && (
          <div className={`mb-4 px-3 py-2 rounded-xl ${cornerClass} bg-red-500/10 border border-red-400/20 text-red-300 text-sm`}>
            {error}
          </div>
        )}

        <form className="space-y-3" onSubmit={handleSubmit}>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-white/90 tracking-tight shrink-0">
              {agentName || "Porrima"}
            </h1>
            {!isSetup && (
              <button
                type="submit"
                className={`flex-1 px-4 py-2.5 rounded-xl ${cornerClass} bg-purple-500/20 border border-purple-400/30 text-purple-200 text-sm font-medium hover:bg-purple-500/30 transition-all pressable flex items-center justify-center gap-2`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
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
                Sign in with Passkey
              </button>
            )}
          </div>

          {isSetup && (
            <>
              <div>
                <label htmlFor="setup-token" className="block text-xs font-medium text-white/55 mb-1.5">
                  Setup token
                </label>
                <input
                  id="setup-token"
                  name="setup-token"
                  type="password"
                  autoComplete="one-time-code"
                  enterKeyHint="done"
                  required
                  value={setupToken}
                  onChange={(event) => setSetupToken(event.target.value)}
                  className={`w-full px-3 py-2.5 rounded-xl ${cornerClass} bg-black/20 border border-white/10 text-white/90 placeholder:text-white/25 outline-none focus:border-purple-400/50 focus:bg-black/30 transition-colors`}
                />
              </div>
              <button
                type="submit"
                className={`w-full px-4 py-2.5 rounded-xl ${cornerClass} bg-purple-500/20 border border-purple-400/30 text-purple-200 text-sm font-medium hover:bg-purple-500/30 transition-all pressable flex items-center justify-center gap-2`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
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
                Register Passkey
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}

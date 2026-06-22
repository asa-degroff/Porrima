import { useState, useEffect, useRef, useCallback } from "react";
import { fetchSshConnections, type ProjectLocationType, type SshConnection } from "../api/client";
import { Dropdown } from "./ui/Dropdown";
import { useDropdown } from "../hooks/useDropdown";

interface Props {
  onClose: () => void;
  onCreate: (name: string, path: string, locationType?: ProjectLocationType, sshConnectionId?: string) => Promise<void>;
}

interface PathValidation {
  valid: boolean;
  exists: boolean;
  isDirectory: boolean;
  isReadable: boolean;
  canCreate?: boolean;
  error?: string;
  hasAgentsMd?: boolean;
}

export function CreateProjectModal({ onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [locationType, setLocationType] = useState<ProjectLocationType>("local");
  const [sshConnectionId, setSshConnectionId] = useState("");
  const [sshConnections, setSshConnections] = useState<SshConnection[]>([]);
  const [loadingSshConnections, setLoadingSshConnections] = useState(false);
  const [validation, setValidation] = useState<PathValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingDirectory, setCreatingDirectory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const sshConnectionDd = useDropdown();
  const selectedSshConnection = sshConnections.find((connection) => connection.id === sshConnectionId);

  // Prefill home directory on mount
  useEffect(() => {
    fetch("/api/projects/defaults", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (data.defaultPath) {
          setPath(data.defaultPath);
        }
      })
      .catch(() => {
        // Fallback to home directory
        const home = process.env.HOME || "~";
        setPath(home);
      });
    
    // Focus name input
    nameInputRef.current?.focus();
  }, []);

  useEffect(() => {
    setLoadingSshConnections(true);
    fetchSshConnections()
      .then((connections) => {
        setSshConnections(connections);
        setSshConnectionId((current) => current || connections[0]?.id || "");
      })
      .catch(() => setSshConnections([]))
      .finally(() => setLoadingSshConnections(false));
  }, []);

  // Escape key to close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  // Debounced path validation
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!path.trim()) {
        setValidation(null);
        return;
      }
      validatePath(path.trim());
    }, 400);

    return () => clearTimeout(timer);
  }, [path, locationType, sshConnectionId]);

  const validatePath = useCallback(async (pathToValidate: string) => {
    setValidating(true);
    setError(null);
    try {
      const res = await fetch("/api/projects/validate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: pathToValidate, locationType, sshConnectionId: locationType === "ssh" ? sshConnectionId : undefined }),
      });
      const data = await res.json();
      setValidation(data);
    } catch (e: any) {
      setValidation({ valid: false, exists: false, isDirectory: false, isReadable: false, error: "Network error" });
    } finally {
      setValidating(false);
    }
  }, [locationType, sshConnectionId]);

  const handleCreateDirectory = async () => {
    if (!validation?.canCreate) return;
    
    setCreatingDirectory(true);
    setError(null);
    try {
      const res = await fetch("/api/projects/create-directory", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path.trim(), locationType, sshConnectionId: locationType === "ssh" ? sshConnectionId : undefined }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Failed to create directory");
      } else {
        // Re-validate the path now that it exists
        await validatePath(path.trim());
      }
    } catch (e: any) {
      setError(e.message || "Failed to create directory");
    } finally {
      setCreatingDirectory(false);
    }
  };

  const handleCreate = async () => {
    if (!name.trim() || !validation?.valid) return;
    
    setCreating(true);
    setError(null);
    try {
      await onCreate(name.trim(), path.trim(), locationType, locationType === "ssh" ? sshConnectionId : undefined);
      onClose();
    } catch (e: any) {
      setError(e.message || "Failed to create project");
    } finally {
      setCreating(false);
    }
  };

  const handleQuickPath = (quickPath: string) => {
    setPath(quickPath);
  };

  const isValid = name.trim().length > 0 && validation?.valid === true;
  const hasRemoteTarget = locationType === "local" || Boolean(sshConnectionId);
  const isInvalid = path.trim().length > 0 && validation && !validation.valid;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center app-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        className="w-full max-w-lg mx-4 bg-[#111318] border border-white/15 rounded-2xl shadow-2xl max-h-[85vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
          <h2 className="text-lg font-semibold text-white/90">New Project</h2>
          <button
            onClick={onClose}
            className="text-white/40 hover:text-white/70 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5 overflow-y-auto">
          {/* Project Name */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Project Name</label>
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project"
              className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-emerald-400/30 focus:border-emerald-400/30 transition-all"
              onKeyDown={(e) => {
                if (e.key === "Enter" && isValid && hasRemoteTarget) {
                  handleCreate();
                }
              }}
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Location</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setLocationType("local");
                  setValidation(null);
                }}
                className={`px-3 py-2 text-sm rounded-lg border transition-all ${
                  locationType === "local"
                    ? "bg-emerald-500/15 border-emerald-400/30 text-emerald-200"
                    : "bg-white/5 border-white/10 text-white/50 hover:bg-white/10"
                }`}
              >
                Local
              </button>
              <button
                type="button"
                onClick={() => {
                  setLocationType("ssh");
                  setValidation(null);
                }}
                className={`px-3 py-2 text-sm rounded-lg border transition-all ${
                  locationType === "ssh"
                    ? "bg-emerald-500/15 border-emerald-400/30 text-emerald-200"
                    : "bg-white/5 border-white/10 text-white/50 hover:bg-white/10"
                }`}
              >
                SSH
              </button>
            </div>
          </div>

          {locationType === "ssh" && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-white/60">SSH Connection</label>
              <Dropdown
                state={sshConnectionDd}
                disabled={loadingSshConnections || sshConnections.length === 0}
                panelClassName="left-0 right-0 top-full mt-1 max-h-[260px] overflow-y-auto"
                trigger={
                  <span className="truncate flex-1 text-left">
                    {loadingSshConnections
                      ? "Loading connections..."
                      : selectedSshConnection
                        ? `${selectedSshConnection.name} (${selectedSshConnection.username ? `${selectedSshConnection.username}@` : ""}${selectedSshConnection.host})`
                        : "Select a connection"}
                  </span>
                }
              >
                {sshConnections.map((connection) => (
                  <button
                    key={connection.id}
                    onClick={() => {
                      setSshConnectionId(connection.id);
                      setValidation(null);
                      sshConnectionDd.close();
                    }}
                    className={`w-full text-left px-3 py-2 text-xs transition-all ${
                      connection.id === sshConnectionId
                        ? "text-white bg-emerald-500/15"
                        : "text-white/60 hover:bg-white/10 hover:text-white/80"
                    }`}
                  >
                    {connection.name} ({connection.username ? `${connection.username}@` : ""}{connection.host})
                  </button>
                ))}
              </Dropdown>
              {sshConnections.length === 0 && !loadingSshConnections && (
                <p className="text-xs text-amber-300/80 bg-amber-500/10 border border-amber-400/20 rounded-lg px-3 py-2">
                  Add an SSH connection in Settings before creating a remote project.
                </p>
              )}
            </div>
          )}

          {/* Project Path */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Project Path</label>
            <div className="relative">
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={locationType === "ssh" ? "/home/user/projects/my-project on the remote host" : "/home/user/projects/my-project"}
                className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-emerald-400/30 focus:border-emerald-400/30 transition-all pr-10"
                onKeyDown={(e) => {
                if (e.key === "Enter" && isValid && hasRemoteTarget) {
                  handleCreate();
                }
                }}
              />
              {validating && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <div className="w-4 h-4 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
                </div>
              )}
              {!validating && validation && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  {validation.valid ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgb(34, 197, 94)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgb(239, 68, 68)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  )}
                </div>
              )}
            </div>

            {/* Validation Feedback */}
            {locationType === "ssh" && !sshConnectionId && (
              <div className="text-xs px-3 py-2 rounded-lg border bg-amber-500/10 border-amber-400/20 text-amber-300">
                Select an SSH connection to validate the remote path.
              </div>
            )}
            {validation && hasRemoteTarget && (
              <div className={`text-xs px-3 py-2 rounded-lg border ${
                validation.valid 
                  ? "bg-emerald-500/10 border-emerald-400/20 text-emerald-300" 
                  : validation.canCreate
                  ? "bg-amber-500/10 border-amber-400/20 text-amber-300"
                  : "bg-red-500/10 border-red-400/20 text-red-300"
              }`}>
                {validation.valid ? (
                  <div className="space-y-1">
                    <div className="font-medium">✓ Path is valid</div>
                    {validation.hasAgentsMd && (
                      <div className="opacity-80">AGENTS.md already exists — will be used for context</div>
                    )}
                  </div>
                ) : validation.canCreate ? (
                  <div className="space-y-2">
                    <div className="font-medium">Path does not exist</div>
                    <div className="opacity-80">Directory can be created at this location</div>
                    <button
                      onClick={handleCreateDirectory}
                      disabled={creatingDirectory}
                      className="mt-2 px-3 py-1.5 text-xs rounded-lg bg-amber-500/20 border border-amber-400/30 text-amber-200 hover:bg-amber-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                      {creatingDirectory && (
                        <div className="w-3 h-3 border-2 border-amber-400/30 border-t-amber-200 rounded-full animate-spin" />
                      )}
                      {creatingDirectory ? "Creating..." : "Create Directory"}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="font-medium">✗ {validation.error || "Invalid path"}</div>
                    {!validation.exists && <div className="opacity-80">Path does not exist</div>}
                    {validation.exists && !validation.isDirectory && <div className="opacity-80">Path is a file, not a directory</div>}
                    {validation.exists && !validation.isReadable && <div className="opacity-80">Path is not readable</div>}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Error Message */}
          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-400/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/10 shrink-0 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white/80 hover:bg-white/10 transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!isValid || !hasRemoteTarget || creating}
            className={`px-4 py-2 text-sm rounded-lg font-medium transition-all flex items-center gap-2 ${
              isValid && hasRemoteTarget && !creating
                ? "bg-emerald-500/20 border border-emerald-400/30 text-emerald-300 hover:bg-emerald-500/30"
                : "bg-white/5 border border-white/10 text-white/30 cursor-not-allowed"
            }`}
          >
            {creating && (
              <div className="w-4 h-4 border-2 border-emerald-400/30 border-t-emerald-300 rounded-full animate-spin" />
            )}
            {creating ? "Creating..." : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  );
}

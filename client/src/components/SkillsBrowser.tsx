import { useState, useEffect, useRef, useCallback } from "react";
import { fetchSkills, installSkill, deleteSkill } from "../api/client";
import type { SkillInfo } from "../api/client";

interface Props {
  onClose: () => void;
  projectId?: string;
}

interface InstallFormState {
  url: string;
  name: string;
  loading: boolean;
  error: string | null;
  success: string | null;
}

export function SkillsBrowser({ onClose, projectId }: Props) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterSource, setFilterSource] = useState<"all" | "global" | "project">("all");
  const [installForm, setInstallForm] = useState<InstallFormState>({
    url: "",
    name: "",
    loading: false,
    error: null,
    success: null,
  });
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const urlInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadSkills();
  }, [projectId]);

  useEffect(() => {
    if (installOpen && urlInputRef.current) {
      urlInputRef.current.focus();
    }
  }, [installOpen]);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchSkills(projectId);
      setSkills(data);
    } catch (err: any) {
      console.error("[SkillsBrowser] Failed to load skills:", err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const handleInstall = useCallback(async () => {
    if (!installForm.url.trim()) {
      setInstallForm((prev) => ({ ...prev, error: "URL is required" }));
      return;
    }

    setInstallForm((prev) => ({ ...prev, loading: true, error: null, success: null }));

    try {
      const result = await installSkill(installForm.url, installForm.name.trim() || undefined);
      setInstallForm({
        url: "",
        name: "",
        loading: false,
        error: null,
        success: result.message,
      });
      await loadSkills();
      setTimeout(() => {
        setInstallForm((prev) => ({ ...prev, success: null }));
      }, 3000);
    } catch (err: any) {
      setInstallForm((prev) => ({
        ...prev,
        loading: false,
        error: err.message || "Failed to install skill",
      }));
    }
  }, [installForm.url, installForm.name, loadSkills]);

  const handleDelete = useCallback(async (skillName: string) => {
    if (!confirm(`Delete skill "${skillName}"? This cannot be undone.`)) {
      return;
    }

    setDeleting(skillName);
    try {
      await deleteSkill(skillName);
      await loadSkills();
    } catch (err: any) {
      console.error("[SkillsBrowser] Failed to delete skill:", err);
      alert(`Failed to delete skill: ${err.message}`);
    } finally {
      setDeleting(null);
    }
  }, [loadSkills]);

  const filteredSkills = skills.filter((skill) => {
    const matchesSearch =
      skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      skill.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesSource = filterSource === "all" || skill.source === filterSource;
    return matchesSearch && matchesSource;
  });

  const globalSkillsCount = skills.filter((s) => s.source === "global").length;
  const projectSkillsCount = skills.filter((s) => s.source === "project").length;

  return (
    <div className="space-y-3 pt-2">
      {/* Install form */}
      {!installOpen ? (
        <button
          onClick={() => setInstallOpen(true)}
          className="w-full px-3 py-2 rounded-lg text-sm font-medium border transition-all flex items-center justify-center gap-2"
          style={{
            backgroundColor: `rgba(var(--theme-secondary), 0.1)`,
            borderColor: `rgba(var(--theme-secondary-border), 0.3)`,
            color: `rgba(var(--theme-secondary-text))`,
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Install New Skill
        </button>
      ) : (
        <div className="space-y-2 p-3 rounded-lg border" style={{
          backgroundColor: `rgba(var(--theme-secondary), 0.05)`,
          borderColor: `rgba(var(--theme-secondary-border), 0.2)`,
        }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-white/70">Install from URL</span>
            <button
              onClick={() => {
                setInstallOpen(false);
                setInstallForm({ url: "", name: "", loading: false, error: null, success: null });
              }}
              className="text-white/40 hover:text-white/70 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {installForm.success && (
            <div className="p-2 rounded bg-emerald-500/10 border border-emerald-400/20 text-emerald-300 text-xs">
              {installForm.success}
            </div>
          )}

          {installForm.error && (
            <div className="p-2 rounded bg-red-500/10 border border-red-400/20 text-red-300 text-xs">
              {installForm.error}
            </div>
          )}

          <div className="space-y-2">
            <div>
              <label className="block text-xs text-white/50 mb-1">Skill URL (GitHub or direct SKILL.md link)</label>
              <input
                ref={urlInputRef}
                type="text"
                value={installForm.url}
                onChange={(e) => setInstallForm((prev) => ({ ...prev, url: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !installForm.loading) {
                    handleInstall();
                  }
                }}
                className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-emerald-400/30 focus:border-emerald-400/30 transition-all"
                placeholder="https://github.com/user/repo/blob/main/skills/example/SKILL.md"
                disabled={installForm.loading}
              />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">Custom name (optional)</label>
              <input
                type="text"
                value={installForm.name}
                onChange={(e) => setInstallForm((prev) => ({ ...prev, name: e.target.value }))}
                className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-emerald-400/30 focus:border-emerald-400/30 transition-all"
                placeholder="Defaults to name from frontmatter"
                disabled={installForm.loading}
              />
            </div>
            <button
              onClick={handleInstall}
              disabled={installForm.loading}
              className="w-full px-3 py-2 rounded-lg text-sm font-medium border transition-all disabled:opacity-40 flex items-center justify-center gap-2"
              style={{
                backgroundColor: `rgba(var(--theme-secondary), 0.15)`,
                borderColor: `rgba(var(--theme-secondary-border))`,
                color: `rgba(var(--theme-secondary-text))`,
              }}
            >
              {installForm.loading ? (
                <>
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                  Installing...
                </>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                  </svg>
                  Install Skill
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="flex gap-2 text-xs">
        <span className="px-2 py-1 rounded-full bg-purple-500/20 border border-purple-400/30 text-purple-300">
          {globalSkillsCount} global
        </span>
        <span className="px-2 py-1 rounded-full bg-emerald-500/20 border border-emerald-400/30 text-emerald-300">
          {projectSkillsCount} project
        </span>
      </div>

      {/* Search and filter */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-2 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-emerald-400/30 focus:border-emerald-400/30 transition-all"
            placeholder="Search skills..."
          />
        </div>
        <select
          value={filterSource}
          onChange={(e) => setFilterSource(e.target.value as typeof filterSource)}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 outline-none focus:ring-1 focus:ring-emerald-400/30 focus:border-emerald-400/30 transition-all cursor-pointer"
        >
          <option value="all">All</option>
          <option value="global">Global</option>
          <option value="project">Project</option>
        </select>
      </div>

      {/* Skills list */}
      <div className="max-h-[320px] overflow-y-auto space-y-1.5 pr-1">
        {loading ? (
          <p className="text-white/30 text-xs text-center py-4">Loading skills...</p>
        ) : filteredSkills.length === 0 ? (
          <p className="text-white/30 text-xs text-center py-4">
            {searchQuery || filterSource !== "all" ? "No skills match your filters" : "No skills installed"}
          </p>
        ) : (
          filteredSkills.map((skill) => {
            const isExpanded = expandedSkill === skill.name;
            const isGlobal = skill.source === "global";
            const isDeleting = deleting === skill.name;

            return (
              <div
                key={skill.name}
                className={`group p-2.5 rounded-lg border transition-all ${
                  isExpanded
                    ? "bg-white/[0.06] border-white/[0.1]"
                    : "bg-white/[0.04] border-white/[0.06] hover:bg-white/[0.07]"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-medium text-white/90">{skill.name}</span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                          isGlobal
                            ? "bg-purple-500/20 text-purple-300 border border-purple-400/30"
                            : "bg-emerald-500/20 text-emerald-300 border border-emerald-400/30"
                        }`}
                      >
                        {skill.source}
                      </span>
                      {skill.projectId && (
                        <span className="text-[9px] text-white/30 truncate max-w-[150px]" title={skill.projectId}>
                          {skill.projectId.slice(0, 8)}...
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-white/50 mt-1 line-clamp-2">{skill.description}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {isGlobal && (
                      <button
                        onClick={() => handleDelete(skill.name)}
                        disabled={isDeleting}
                        className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-white/30 hover:text-red-400 transition-all disabled:opacity-50"
                        title="Delete skill"
                      >
                        {isDeleting ? (
                          <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                          </svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                          </svg>
                        )}
                      </button>
                    )}
                    <button
                      onClick={() => setExpandedSkill(isExpanded ? null : skill.name)}
                      className="p-1 rounded hover:bg-white/10 text-white/30 hover:text-white/60 transition-all"
                      title={isExpanded ? "Collapse" : "Expand"}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`transition-transform ${isExpanded ? "rotate-180" : ""}`}
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="mt-2 pt-2 border-t border-white/[0.06]">
                    <div className="space-y-2 text-xs">
                      {skill.source === "global" && (
                        <div className="flex items-center gap-2 text-white/40">
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                          </svg>
                          <span className="truncate">~/.porrima/skills/{skill.name}/</span>
                        </div>
                      )}
                      <div className="text-white/50">
                        <span className="font-medium text-white/60">Description:</span> {skill.description}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

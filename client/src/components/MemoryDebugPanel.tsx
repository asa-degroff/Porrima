import { useEffect, useRef, useState } from "react";

// Kept aligned with server/src/services/memory-extraction-observability.ts.
// Duplicated rather than shared because this is a debug surface and we don't
// want to entangle client types with an internal server type.
type ExtractionTrigger = "immediate" | "delayed" | "pre-compaction" | "notebook" | "other";
type ExtractionStatus = "running" | "success" | "error";

interface ExtractionMessageView {
  role: string;
  content: string;
}

interface ExtractionParsedFact {
  text: string;
  category?: string;
  importance?: number;
}

interface ExtractionResults {
  facts: ExtractionParsedFact[];
  saved: number;
  superseded: number;
  skippedDuplicates: number;
  errors: number;
}

interface ExtractionRun {
  id: string;
  trigger: ExtractionTrigger;
  chatId?: string;
  chatTitle?: string;
  model: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: ExtractionStatus;
  priorMemoryCount: number;
  messages: ExtractionMessageView[];
  systemPrompt: string;
  userPrompt: string;
  rawOutput?: string;
  results?: ExtractionResults;
  error?: string;
}

interface ExtractionEvent {
  type: "start" | "output" | "complete" | "error";
  run: ExtractionRun;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusColor(status: ExtractionStatus): string {
  switch (status) {
    case "running": return "text-amber-300/70";
    case "success": return "text-emerald-300/70";
    case "error":   return "text-red-300/70";
  }
}

function triggerColor(trigger: ExtractionTrigger): string {
  switch (trigger) {
    case "immediate":      return "text-purple-300/70 border-purple-400/20 bg-purple-500/5";
    case "delayed":        return "text-sky-300/70 border-sky-400/20 bg-sky-500/5";
    case "pre-compaction": return "text-amber-300/70 border-amber-400/20 bg-amber-500/5";
    case "notebook":       return "text-emerald-300/70 border-emerald-400/20 bg-emerald-500/5";
    default:               return "text-white/50 border-white/10 bg-white/5";
  }
}

export function MemoryDebugPanel({ isOpen, onClose }: Props) {
  const [runs, setRuns] = useState<ExtractionRun[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const es = new EventSource("/api/memory/extraction/stream", { withCredentials: true });
    esRef.current = es;

    es.addEventListener("snapshot", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        setRuns(data.runs ?? []);
        setConnected(true);
      } catch { /* ignore malformed snapshot */ }
    });

    es.addEventListener("run", (e) => {
      try {
        const ev = JSON.parse((e as MessageEvent).data) as ExtractionEvent;
        setRuns((prev) => {
          const idx = prev.findIndex((r) => r.id === ev.run.id);
          if (idx === -1) return [ev.run, ...prev].slice(0, 50);
          const next = prev.slice();
          next[idx] = ev.run;
          return next;
        });
      } catch { /* ignore malformed event */ }
    });

    es.addEventListener("error", () => {
      setConnected(false);
    });

    es.addEventListener("open", () => setConnected(true));

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900/95 border border-white/10 rounded-xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium text-white/90">Memory Extraction Debug</h2>
            <span className={`text-[10px] ${connected ? "text-emerald-400/80" : "text-white/30"}`}>
              {connected ? "● live" : "○ disconnected"}
            </span>
            <span className="text-[10px] text-white/30">{runs.length} run(s)</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-white/40 hover:text-white/80 transition-colors"
            title="Close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {runs.length === 0 ? (
            <div className="p-8 text-center text-white/30 text-sm">
              No extraction runs yet. Send a message, trigger compaction, or wait for a delayed extraction.
            </div>
          ) : (
            <ul className="divide-y divide-white/5">
              {runs.map((run) => {
                const isExpanded = expandedId === run.id;
                return (
                  <li key={run.id} className="text-xs">
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : run.id)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/5 text-left transition-colors"
                    >
                      <span className={`inline-flex items-center gap-1 ${statusColor(run.status)} w-20 shrink-0`}>
                        {run.status === "running" ? "●" : run.status === "success" ? "✓" : "✗"}
                        <span>{run.status}</span>
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] border ${triggerColor(run.trigger)} shrink-0`}>
                        {run.trigger}
                      </span>
                      <span className="flex-1 truncate text-white/70">
                        {run.chatTitle || run.chatId || "—"}
                      </span>
                      <span className="text-white/30 shrink-0">
                        {run.results ? `${run.results.facts.length} fact(s)` : "…"}
                      </span>
                      <span className="text-white/30 w-12 text-right shrink-0">
                        {formatDuration(run.durationMs)}
                      </span>
                      <span className="text-white/20 w-20 text-right shrink-0">
                        {formatTime(run.startedAt)}
                      </span>
                    </button>
                    {isExpanded && <RunDetail run={run} />}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function RunDetail({ run }: { run: ExtractionRun }) {
  return (
    <div className="px-4 pb-4 space-y-3 bg-black/20">
      {run.error && (
        <Section title="Error" defaultOpen>
          <pre className="text-red-300/80 text-[11px] whitespace-pre-wrap">{run.error}</pre>
        </Section>
      )}
      <div className="flex gap-4 text-[10px] text-white/40 pt-2">
        <span>model: <span className="text-white/60">{run.model}</span></span>
        <span>prior memories: <span className="text-white/60">{run.priorMemoryCount}</span></span>
        {run.results && (
          <>
            <span>saved: <span className="text-emerald-300/70">{run.results.saved}</span></span>
            <span>superseded: <span className="text-sky-300/70">{run.results.superseded}</span></span>
            <span>skipped: <span className="text-white/40">{run.results.skippedDuplicates}</span></span>
          </>
        )}
      </div>
      {run.results && run.results.facts.length > 0 && (
        <Section title={`Parsed Facts (${run.results.facts.length})`} defaultOpen>
          <ul className="space-y-1.5">
            {run.results.facts.map((f, i) => (
              <li key={i} className="text-[11px] flex gap-2">
                {f.category && (
                  <span className="text-white/40 shrink-0 w-20 truncate">[{f.category}]</span>
                )}
                {f.importance !== undefined && (
                  <span className="text-white/40 shrink-0 w-8">i{f.importance}</span>
                )}
                <span className="text-white/80 flex-1">{f.text}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={`Messages (${run.messages.length})`}>
        <div className="space-y-2">
          {run.messages.map((m, i) => (
            <div key={i} className="text-[11px]">
              <div className="text-white/40 mb-0.5">{m.role}:</div>
              <pre className="text-white/70 whitespace-pre-wrap break-words bg-black/30 p-2 rounded max-h-48 overflow-y-auto">
                {m.content}
              </pre>
            </div>
          ))}
        </div>
      </Section>
      <Section title="System Prompt">
        <pre className="text-white/70 text-[11px] whitespace-pre-wrap break-words bg-black/30 p-2 rounded max-h-64 overflow-y-auto">
          {run.systemPrompt}
        </pre>
      </Section>
      <Section title="User Prompt">
        <pre className="text-white/70 text-[11px] whitespace-pre-wrap break-words bg-black/30 p-2 rounded max-h-64 overflow-y-auto">
          {run.userPrompt}
        </pre>
      </Section>
      {run.rawOutput !== undefined && (
        <Section title="Raw Output" defaultOpen>
          <pre className="text-emerald-100/80 text-[11px] whitespace-pre-wrap break-words bg-black/30 p-2 rounded max-h-96 overflow-y-auto">
            {run.rawOutput || <span className="text-white/30">(empty)</span>}
          </pre>
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  children,
  defaultOpen,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/40 hover:text-white/70 transition-colors"
      >
        <span>{open ? "▼" : "▶"}</span>
        <span>{title}</span>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

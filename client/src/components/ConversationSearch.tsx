import { useState, useRef, useEffect } from "react";
import { searchConversations } from "../api/client";
import type { ConversationSearchResult } from "../types";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelectResult: (chatId: string, messageIndex: number) => void;
}

export function ConversationSearch({ isOpen, onClose, onSelectResult }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConversationSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim().length >= 2) {
        doSearch();
      } else {
        setResults([]);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  async function doSearch() {
    setLoading(true);
    setError(null);
    try {
      const r = await searchConversations(query, undefined, 20);
      setResults(r);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function handleSelect(result: ConversationSearchResult) {
    onSelectResult(result.chatId, result.messageIndex);
    onClose();
    setQuery("");
    setResults([]);
  }

  if (!isOpen) return null;

  return (
    <div className="absolute inset-x-0 top-0 z-40 bg-[#0a0a0f]/0.98 backdrop-blur-xl border-b border-white/10 shadow-2xl">
      <div className="p-3">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations..."
            className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white/90 text-sm focus:outline-none focus:border-white/20 focus:bg-white/10 transition-all placeholder:text-white/30"
          />
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {loading && (
          <div className="mt-3 text-center text-white/30 text-xs py-2">
            Searching...
          </div>
        )}

        {error && (
          <div className="mt-3 text-center text-red-400/70 text-xs py-2">
            {error}
          </div>
        )}

        {results.length > 0 && (
          <div className="mt-2 max-h-96 overflow-y-auto">
            {results.map((r, i) => (
              <button
                key={`${r.chatId}-${r.messageIndex}-${i}`}
                onClick={() => handleSelect(r)}
                className="w-full text-left px-3 py-2.5 hover:bg-white/5 rounded-lg transition-colors border border-transparent hover:border-white/5"
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white/40 mb-0.5 truncate">
                      {r.chatTitle || "Untitled"} • Message {r.messageIndex + 1}
                    </div>
                    <div className="text-sm text-white/80 truncate">
                      {r.content}
                    </div>
                  </div>
                  <span className="text-[10px] text-white/20 shrink-0 mt-0.5">
                    {r.role}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

        {query.trim().length >= 2 && results.length === 0 && !loading && !error && (
          <div className="mt-3 text-center text-white/30 text-xs py-2">
            No matches found
          </div>
        )}
      </div>
    </div>
  );
}

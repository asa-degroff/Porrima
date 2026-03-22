import { useState, useRef, useEffect } from "react";
import { searchConversations } from "../api/client";
import type { ConversationSearchResult } from "../types";

interface Props {
  isActive: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onSelectResult: (result: ConversationSearchResult) => void;
}

export function SidebarSearch({ isActive, query, onQueryChange, onClose, onSelectResult }: Props) {
  const [results, setResults] = useState<ConversationSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isActive && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isActive]);

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
    try {
      const r = await searchConversations(query, undefined, 20);
      setResults(r);
    } catch (e: any) {
      console.error("Search failed:", e);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  function handleSelect(result: ConversationSearchResult) {
    onSelectResult(result);
    onQueryChange("");
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
      onQueryChange("");
    }
  }

  return (
    <div className="flex items-center gap-2 px-1 w-full">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/30 shrink-0">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search conversations..."
        className="flex-1 bg-transparent text-white/90 text-sm focus:outline-none placeholder:text-white/30"
      />
      {query && (
        <button
          onClick={() => { onQueryChange(""); setResults([]); }}
          className="text-white/30 hover:text-white/60 transition-colors p-0.5 shrink-0"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}

interface SearchResultsProps {
  results: ConversationSearchResult[];
  loading: boolean;
  query: string;
  onSelectResult: (result: ConversationSearchResult) => void;
}

export function SearchResults({ results, loading, query, onSelectResult }: SearchResultsProps) {
  if (results.length === 0 && !loading && query.trim().length < 2) {
    return null;
  }

  return (
    <div className="px-3 pb-2">
      {results.length > 0 && (
        <div className="space-y-0.5 max-h-64 overflow-y-auto">
          {results.map((r, i) => (
            <button
              key={`${r.chatId}-${r.messageIndex}-${i}`}
              onClick={() => onSelectResult(r)}
              className="w-full text-left px-2 py-2 hover:bg-white/5 rounded-lg transition-colors"
            >
              <div className="flex items-start gap-2 min-w-0">
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] text-white/40 mb-0.5 truncate">
                    {r.chatTitle || "Untitled"} • Message {r.messageIndex + 1}
                  </div>
                  <div className="text-xs text-white/70 truncate">
                    {r.content}
                  </div>
                </div>
                <span className="text-[9px] text-white/20 shrink-0 mt-0.5 uppercase">
                  {r.role}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {query.trim().length >= 2 && results.length === 0 && !loading && (
        <div className="text-center text-white/30 text-xs py-2">
          No matches found
        </div>
      )}

      {loading && (
        <div className="text-center text-white/30 text-xs py-2">
          Searching...
        </div>
      )}
    </div>
  );
}

import { useState, useCallback, useEffect } from "react";
import { searchImages } from "../api/client";
import type { GeneratedImage } from "../types";

interface Props {
  onResults: (results: Array<GeneratedImage & { score: number }>) => void;
  onClear: () => void;
  placeholder?: string;
}

export function ImageSearch({ onResults, onClear, placeholder = "Search images..." }: Props) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // 300ms debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      console.log("[ImageSearch] debouncing:", query, "->", query);
      setDebouncedQuery(query);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    console.log("[ImageSearch] effect triggered, debouncedQuery:", debouncedQuery, "trim:", debouncedQuery.trim());
    if (!debouncedQuery.trim()) {
      console.log("[ImageSearch] clearing results");
      onClear();
      return;
    }

    let cancelled = false;
    console.log("[ImageSearch] starting search for:", debouncedQuery);
    setSearching(true);

    searchImages(debouncedQuery, 20)
      .then((results) => {
        console.log("[ImageSearch] got", results.length, "results");
        if (!cancelled) {
          onResults(results);
          setSearching(false);
        }
      })
      .catch((err) => {
        console.error("[ImageSearch] search error:", err.message);
        if (!cancelled) {
          onResults([]);
          setSearching(false);
        }
      });

    return () => {
      console.log("[ImageSearch] cleanup, setting cancelled=true");
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- onResults/onClear are stable useCallback refs; including them causes re-trigger loops
  }, [debouncedQuery]);

  const handleClear = useCallback(() => {
    setQuery("");
    onClear();
  }, [onClear]);

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 pr-10 text-sm bg-white/5 border border-white/10 rounded-lg text-white/80 placeholder-white/30 focus:outline-none focus:border-purple-400/40 focus:bg-white/10 transition-colors"
      />
      {/* Right-side actions - cancel button or spinner, mutually exclusive */}
      {query && !searching && (
        <button
          onClick={handleClear}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-white/40 hover:text-white/70 transition-colors"
          title="Clear search"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18" />
            <path d="M6 6l12 12" />
          </svg>
        </button>
      )}
      {searching && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2">
          <div className="w-4 h-4 rounded-full border-2 border-purple-400/30 border-t-purple-400 animate-spin" />
        </div>
      )}
    </div>
  );
}

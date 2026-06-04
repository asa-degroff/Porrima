import { useState, useCallback, useEffect, useRef } from "react";
import type { NotebookEntry, NotebookIndex, NotebookLink, NotebookSearchResult, ChatListItem, ImageAttachment } from "../types";
import { fetchNotebookEntry, fetchNotebookEntriesBulk } from "../api/client";
import { NotebookEntryComposer } from "./NotebookEntryComposer";
import { NotebookEntryDisplay } from "./NotebookEntryDisplay";
import { ChatLinkPicker } from "./ChatLinkPicker";
import { NotebookLinkPicker } from "./NotebookLinkPicker";

/** How many of the most recent entries per author are auto-expanded on mount. */
const AUTO_EXPAND_COUNT = 3;

const COMPOSER_TARGET = '__composer__';

interface Props {
  userNotebooks: NotebookIndex;
  agentNotebooks: NotebookIndex;
  loading?: boolean;
  error?: string | null;
  onCreateUserEntry: (content: string, images?: ImageAttachment[]) => Promise<NotebookEntry>;
  onCreateAgentEntry: (content: string) => Promise<void>;
  onUpdateEntry: (author: 'user' | 'agent', id: string, updates: { content?: string; links?: NotebookLink }) => Promise<void>;
  onDeleteEntry: (author: 'user' | 'agent', id: string) => Promise<void>;
  onReadAloud?: (text: string) => void;
  onTriggerAgentReview: () => Promise<{ skipped?: boolean; reason?: string } | NotebookEntry>;
  chats: ChatListItem[];
  onChatSelect: (chatId: string) => void;
  onVisible?: () => void;
  onOpenSidebar?: () => void;
  searchResults?: NotebookSearchResult[];
  searchQuery?: string;
  isSearching?: boolean;
  onSearch?: (query: string) => void;
  onClearSearch?: () => void;
}

export function NotebookView({
  userNotebooks,
  agentNotebooks,
  loading,
  error,
  onCreateUserEntry,
  onCreateAgentEntry,
  onUpdateEntry,
  onDeleteEntry,
  onReadAloud,
  onTriggerAgentReview,
  chats,
  onChatSelect,
  onVisible,
  onOpenSidebar,
  searchResults = [],
  searchQuery = '',
  isSearching = false,
  onSearch,
  onClearSearch,
}: Props) {
  const [fullEntries, setFullEntries] = useState<Record<string, NotebookEntry>>({});
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [editingEntry, setEditingEntry] = useState<{ author: 'user' | 'agent'; id: string; content: string } | null>(null);
  const [composerLinks, setComposerLinks] = useState<NotebookLink>({});
  const [mobileNotebookTab, setMobileNotebookTab] = useState<'user' | 'agent'>('user');
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && !window.matchMedia('(min-width: 768px)').matches);
  const [searchInput, setSearchInput] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(!e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  // Search debounce
  const handleSearchInput = useCallback((value: string) => {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!value.trim()) {
      onClearSearch?.();
      return;
    }
    searchDebounceRef.current = setTimeout(() => {
      onSearch?.(value.trim());
    }, 300);
  }, [onSearch, onClearSearch]);

  const toggleSearch = useCallback(() => {
    setShowSearch(prev => {
      if (prev) {
        // Closing search
        setSearchInput('');
        onClearSearch?.();
      } else {
        // Opening search - focus input after render
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
      return !prev;
    });
  }, [onClearSearch]);

  const handleSearchResultClick = useCallback((result: NotebookSearchResult) => {
    // Scroll to and expand the entry
    const element = document.getElementById(`entry-${result.id}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
      element.classList.add('ring-2', 'ring-purple-400');
      setTimeout(() => element.classList.remove('ring-2', 'ring-purple-400'), 2000);
    }
    // Expand the entry if not already expanded
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.add(result.id);
      return next;
    });
    // Fetch full content if not cached
    if (!fullEntries[result.id]) {
      fetchNotebookEntry(result.author, result.id)
        .then(entry => {
          if (entry) setFullEntries(prev => ({ ...prev, [result.id]: entry }));
        })
        .catch(() => { /* ignore */ });
    }
    // Close search on mobile after selecting a result
    if (isMobile) {
      setShowSearch(false);
      setSearchInput('');
      onClearSearch?.();
    }
  }, [fullEntries, isMobile, onClearSearch]);

  // Link picker state
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkPickerType, setLinkPickerType] = useState<'chat' | 'notebook' | null>(null);
  const [linkPickerAnchor, setLinkPickerAnchor] = useState<DOMRect | null>(null);
  const [pendingLink, setPendingLink] = useState<{ entryId: string; author: 'user' | 'agent' } | null>(null);
  const [filterText, setFilterText] = useState('');

  // Mark as seen when view becomes visible
  useEffect(() => {
    onVisible?.();
  }, [onVisible]);

  // Auto-expand the most recent entries and eagerly fetch their full content
  useEffect(() => {
    const toExpand = [
      ...userNotebooks.entries.slice(0, AUTO_EXPAND_COUNT),
      ...agentNotebooks.entries.slice(0, AUTO_EXPAND_COUNT),
    ];
    const newIds = toExpand.map(e => e.id);
    if (newIds.length === 0) return;

    setExpandedIds(prev => {
      const next = new Set(prev);
      newIds.forEach(id => next.add(id));
      return next;
    });

    // Eagerly fetch full content for the auto-expanded entries
    const missing = toExpand.filter(e => !fullEntries[e.id]);
    if (missing.length === 0) return;

    fetchNotebookEntriesBulk(missing.map(e => ({ author: e.author, id: e.id })))
      .then((results) => {
        setFullEntries(prev => {
          const next = { ...prev };
          for (const [id, entry] of Object.entries(results)) {
            if (entry) next[id] = entry;
          }
          return next;
        });
      })
      .catch(() => {
        // Fallback to individual fetches
        missing.forEach(async (e) => {
          try {
            const entry = await fetchNotebookEntry(e.author, e.id);
            if (entry) {
              setFullEntries(prev => ({ ...prev, [e.id]: entry }));
            }
          } catch { /* ignore */ }
        });
      });
  }, [userNotebooks.entries, agentNotebooks.entries]);

  // Toggle entry expansion — fetch full content on first expand
  const toggleExpand = useCallback((author: 'user' | 'agent', id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        // Fetch full content if not yet cached
        if (!fullEntries[id]) {
          fetchNotebookEntry(author, id)
            .then(entry => {
              if (entry) setFullEntries(prev => ({ ...prev, [id]: entry }));
            })
            .catch(() => { /* ignore */ });
        }
      }
      return next;
    });
  }, [fullEntries]);

  // --- Composer handlers ---

  const handleCreateUserEntry = useCallback(async (content: string, links?: NotebookLink, images?: ImageAttachment[]) => {
    const entry = await onCreateUserEntry(content, images);
    // If links were attached in the composer, update the entry with them
    const linksToSave = links || (composerLinks.chats?.length || composerLinks.notebooks?.length ? composerLinks : undefined);
    if (linksToSave && entry) {
      await onUpdateEntry('user', entry.id, { links: linksToSave });
      // Add to local cache with links
      setFullEntries(prev => ({ ...prev, [entry.id]: { ...entry, links: linksToSave } }));
    }
    setComposerLinks({});
  }, [onCreateUserEntry, onUpdateEntry, composerLinks]);

  const handleComposerOpenLinkPicker = useCallback((type: 'chat' | 'notebook', anchorRect: DOMRect) => {
    setLinkPickerType(type);
    setLinkPickerAnchor(anchorRect);
    setPendingLink({ entryId: COMPOSER_TARGET, author: 'user' });
    setFilterText('');
    setLinkPickerOpen(true);
  }, []);

  const handleRemoveComposerLink = useCallback((linkType: 'chat' | 'notebook' | 'url', index: number) => {
    setComposerLinks(prev => ({
      ...prev,
      chats: linkType === 'chat' ? (prev.chats || []).filter((_, i) => i !== index) : prev.chats,
      notebooks: linkType === 'notebook' ? (prev.notebooks || []).filter((_, i) => i !== index) : prev.notebooks,
      urls: linkType === 'url' ? (prev.urls || []).filter((_, i) => i !== index) : prev.urls,
    }));
  }, []);

  // --- Entry handlers ---

  const handleTriggerAgent = useCallback(async () => {
    const result = await onTriggerAgentReview();
    if ('skipped' in result && result.skipped) {
      console.log("Agent review skipped:", result.reason);
    }
  }, [onTriggerAgentReview]);

  const handleEdit = useCallback((author: 'user' | 'agent', id: string, content: string) => {
    setEditingEntry({ author, id, content });
  }, []);

  const handleSaveEdit = useCallback(async (id: string, newContent: string) => {
    if (editingEntry) {
      await onUpdateEntry(editingEntry.author, id, { content: newContent });
      setFullEntries(prev => {
        const entry = prev[id];
        if (!entry) return prev;
        return { ...prev, [id]: { ...entry, content: newContent } };
      });
      setEditingEntry(null);
    }
  }, [editingEntry, onUpdateEntry]);

  const handleDelete = useCallback(async (author: 'user' | 'agent', id: string) => {
    await onDeleteEntry(author, id);
    if (editingEntry?.id === id) setEditingEntry(null);
    setFullEntries(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, [onDeleteEntry, editingEntry]);

  const handleRemoveLink = useCallback(async (entryId: string, author: 'user' | 'agent', linkType: 'chat' | 'notebook' | 'url', index: number) => {
    const entry = fullEntries[entryId];
    if (!entry?.links) return;

    const updatedLinks: NotebookLink = {
      chats: linkType === 'chat' ? (entry.links.chats || []).filter((_, i) => i !== index) : entry.links.chats,
      notebooks: linkType === 'notebook' ? (entry.links.notebooks || []).filter((_, i) => i !== index) : entry.links.notebooks,
      urls: linkType === 'url' ? (entry.links.urls || []).filter((_, i) => i !== index) : entry.links.urls,
    };

    await onUpdateEntry(author, entryId, { links: updatedLinks });
    setFullEntries(prev => {
      const e = prev[entryId];
      if (!e) return prev;
      return { ...prev, [entryId]: { ...e, links: updatedLinks } };
    });
  }, [fullEntries, onUpdateEntry]);

  const handleEntryLinkClick = useCallback((author: 'user' | 'agent', entryId: string) => {
    const element = document.getElementById(`entry-${entryId}`);
    element?.scrollIntoView({ behavior: 'smooth' });
    element?.classList.add('ring-2', 'ring-purple-400');
    setTimeout(() => element?.classList.remove('ring-2', 'ring-purple-400'), 2000);
  }, []);

  const handleChatLinkClick = useCallback((chatId: string) => {
    onChatSelect(chatId);
  }, [onChatSelect]);

  // --- Link picker ---

  const openLinkPicker = useCallback((type: 'chat' | 'notebook', anchorRect: DOMRect, entryId: string, author: 'user' | 'agent') => {
    setLinkPickerType(type);
    setLinkPickerAnchor(anchorRect);
    setPendingLink({ entryId, author });
    setFilterText('');
    setLinkPickerOpen(true);
  }, []);

  const handleLinkSelect = useCallback(async (targetId: string, targetAuthorOrTitle: string, preview?: string) => {
    if (!pendingLink) return;

    const newLink: NotebookLink = {};
    if (linkPickerType === 'chat') {
      newLink.chats = [{ chatId: targetId, title: preview || targetAuthorOrTitle }];
    } else {
      newLink.notebooks = [{ entryId: targetId, author: targetAuthorOrTitle as 'user' | 'agent' }];
    }

    if (pendingLink.entryId === COMPOSER_TARGET) {
      // Add link to composer's pending links (no server call yet)
      setComposerLinks(prev => ({
        chats: [...(prev.chats || []), ...(newLink.chats || [])],
        notebooks: [...(prev.notebooks || []), ...(newLink.notebooks || [])],
      }));
    } else {
      // Merge with existing links on the entry, then send full set to server
      const existingEntry = fullEntries[pendingLink.entryId];
      const existingLinks = existingEntry?.links || {};
      const mergedLinks: NotebookLink = {
        chats: [...(existingLinks.chats || []), ...(newLink.chats || [])],
        notebooks: [...(existingLinks.notebooks || []), ...(newLink.notebooks || [])],
      };

      await onUpdateEntry(pendingLink.author, pendingLink.entryId, { links: mergedLinks });
      setFullEntries(prev => {
        const entry = prev[pendingLink.entryId];
        if (!entry) return prev;
        return { ...prev, [pendingLink.entryId]: { ...entry, links: mergedLinks } };
      });
    }

    setLinkPickerOpen(false);
    setLinkPickerType(null);
    setPendingLink(null);
  }, [pendingLink, linkPickerType, onUpdateEntry, fullEntries]);

  const closeLinkPicker = useCallback(() => {
    setLinkPickerOpen(false);
    setLinkPickerType(null);
    setPendingLink(null);
  }, []);

  // Close picker on Escape key or click outside
  useEffect(() => {
    if (!linkPickerOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLinkPicker();
    };
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.link-picker-popup')) closeLinkPicker();
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [linkPickerOpen, closeLinkPicker]);

  // --- Render ---

  const renderEntries = useCallback((entries: NotebookIndex['entries'], author: 'user' | 'agent') => {
    return entries.map((entryInfo) => {
      const expanded = expandedIds.has(entryInfo.id);
      const entry = fullEntries[entryInfo.id] || {
        id: entryInfo.id,
        createdAt: entryInfo.createdAt,
        author: entryInfo.author,
        content: entryInfo.preview,
      };

      return (
        <div
          key={entry.id}
          id={`entry-${entry.id}`}
          className="mb-4"
        >
          {editingEntry?.id === entry.id ? (
            <NotebookEntryComposer
              initialContent={editingEntry.content}
              onSubmit={(content) => handleSaveEdit(entry.id, content)}
              onCancel={() => setEditingEntry(null)}
              autoFocus
            />
          ) : (
            <NotebookEntryDisplay
              entry={entry}
              expanded={expanded}
              preview={expanded ? undefined : entryInfo.preview}
              onToggleExpand={() => toggleExpand(author, entry.id)}
              onEdit={author === 'user' && expanded ? () => handleEdit(author, entry.id, fullEntries[entry.id]?.content || entry.content) : undefined}
              onDelete={() => handleDelete(author, entry.id)}
              onReadAloud={onReadAloud}
              onLinkClick={handleEntryLinkClick}
              onChatLinkClick={handleChatLinkClick}
              onAddLink={author === 'user' && expanded ? (type: 'chat' | 'notebook', anchorRect) => openLinkPicker(type, anchorRect, entry.id, author) : undefined}
              onRemoveLink={author === 'user' && expanded ? (linkType, index) => handleRemoveLink(entry.id, author, linkType, index) : undefined}
            />
          )}
        </div>
      );
    });
  }, [fullEntries, expandedIds, editingEntry, handleEdit, handleSaveEdit, handleDelete, handleEntryLinkClick, handleChatLinkClick, openLinkPicker, handleRemoveLink, toggleExpand]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-white/40 text-sm">Loading notebooks...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-red-400/80 text-sm">{error}</div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {/* Header */}
      <div className="px-3 md:px-6 py-3 border-b border-white/10 flex items-center gap-2 md:gap-3 backdrop-blur-sm bg-white/[0.03]">
        {/* Left: hamburger + title */}
        <div className="flex items-center gap-2 min-w-0">
          {/* Hamburger menu - mobile only */}
          <button
            onClick={onOpenSidebar}
            className="md:hidden text-white/50 hover:text-white/80 transition-colors p-1 rounded-lg hover:bg-white/5 shrink-0 pressable"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <h2 className="text-sm font-medium text-white/80 truncate">Notebooks</h2>
        </div>

        {/* Spacer */}
        <div className="flex-1 min-w-0" />

        {/* Right: search + actions */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Inline search bar (desktop only) */}
          <div className="hidden md:block relative w-[300px]">
            <input
              ref={searchInputRef}
              type="text"
              value={searchInput}
              onChange={(e) => handleSearchInput(e.target.value)}
              placeholder="Search notebooks..."
              className="w-full pl-8 pr-8 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/90 text-sm focus:outline-none focus:border-purple-400/40 focus:bg-white/10 transition-all placeholder:text-white/30"
            />
            {/* Search icon */}
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30 pointer-events-none">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            {/* Clear button */}
            {searchInput && (
              <button
                onClick={() => { setSearchInput(''); onClearSearch?.(); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-white/40 hover:text-white/70 transition-colors pressable"
                title="Clear search"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
          {/* Search toggle - mobile only */}
          <button
            onClick={toggleSearch}
            className={`md:hidden p-1.5 rounded-lg transition-colors pressable ${showSearch ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/80 hover:bg-white/5'}`}
            title={showSearch ? 'Close search' : 'Search notebooks'}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          <button
            onClick={handleTriggerAgent}
            className="px-3 py-1.5 text-xs rounded-lg transition-colors bg-purple-500/15 border border-purple-400/25 text-purple-300 font-medium hover:bg-purple-500/25 pressable"
            title="Trigger agent review of today's notes"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline mr-1">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            Review Notes
          </button>
        </div>
      </div>

      {/* Desktop search results — inline below header, shown when there's a query */}
      {searchInput.trim().length >= 2 && (
        <div className="hidden md:block px-6 py-2 border-b border-white/10 bg-white/[0.02]">
          {isSearching && (
            <div className="text-center text-white/30 text-xs py-2">Searching...</div>
          )}
          {!isSearching && searchResults.length > 0 && (
            <div className="max-h-64 overflow-y-auto space-y-1">
              {searchResults.map((result) => (
                <button
                  key={result.id}
                  onClick={() => handleSearchResultClick(result)}
                  className="w-full text-left px-3 py-2 hover:bg-white/5 rounded-lg transition-colors border border-transparent hover:border-white/5"
                >
                  <div className="flex items-start gap-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${result.author === 'agent' ? 'bg-purple-500/15 text-purple-300' : 'bg-blue-500/15 text-blue-300'}`}>
                      {result.author === 'agent' ? 'Agent' : 'You'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-white/40">
                        {new Date(result.createdAt).toLocaleDateString()}
                      </div>
                      <div className="text-sm text-white/80 line-clamp-2">
                        {result.excerpt || result.preview}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {!isSearching && searchResults.length === 0 && searchQuery && (
            <div className="text-center text-white/30 text-xs py-2">No matches found</div>
          )}
        </div>
      )}

      {/* Mobile search bar — expanded below header */}
      {showSearch && (
        <div className="md:hidden px-3 py-2 border-b border-white/10 bg-white/[0.02]">
          <div className="flex items-center gap-2">
            <input
              ref={searchInputRef}
              type="text"
              value={searchInput}
              onChange={(e) => handleSearchInput(e.target.value)}
              placeholder="Search notebooks..."
              className="flex-1 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/90 text-sm focus:outline-none focus:border-purple-400/40 focus:bg-white/10 transition-all placeholder:text-white/30"
            />
            {searchInput && (
              <button
                onClick={() => { setSearchInput(''); onClearSearch?.(); }}
                className="p-1 text-white/40 hover:text-white/70 transition-colors pressable"
                title="Clear search"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
          {/* Search results */}
          {isSearching && (
            <div className="mt-2 text-center text-white/30 text-xs py-2">Searching...</div>
          )}
          {!isSearching && searchResults.length > 0 && (
            <div className="mt-2 max-h-64 overflow-y-auto space-y-1">
              {searchResults.map((result) => (
                <button
                  key={result.id}
                  onClick={() => handleSearchResultClick(result)}
                  className="w-full text-left px-3 py-2 hover:bg-white/5 rounded-lg transition-colors border border-transparent hover:border-white/5"
                >
                  <div className="flex items-start gap-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${result.author === 'agent' ? 'bg-purple-500/15 text-purple-300' : 'bg-blue-500/15 text-blue-300'}`}>
                      {result.author === 'agent' ? 'Agent' : 'You'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-white/40">
                        {new Date(result.createdAt).toLocaleDateString()}
                      </div>
                      <div className="text-sm text-white/80 line-clamp-2">
                        {result.excerpt || result.preview}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {!isSearching && searchResults.length === 0 && searchInput.trim().length >= 2 && searchQuery && (
            <div className="mt-2 text-center text-white/30 text-xs py-2">No matches found</div>
          )}
        </div>
      )}

      {/* Content - Tabbed on mobile, side-by-side on desktop */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden w-full">
        {/* Mobile tab bar - compact rounded selector */}
        {isMobile && <div className="px-3 py-2 shrink-0">
          <div className="flex rounded-lg bg-white/[0.05] p-0.5 w-full">
            <button
              onClick={() => setMobileNotebookTab('user')}
              className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-all min-w-0 truncate ${
                mobileNotebookTab === 'user'
                  ? 'bg-white/10 text-white shadow-sm'
                  : 'text-white/50 hover:text-white/70'
              }`}
            >
              Your Notebook
            </button>
            <button
              onClick={() => setMobileNotebookTab('agent')}
              className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-all min-w-0 truncate ${
                mobileNotebookTab === 'agent'
                  ? 'bg-purple-500/20 text-white shadow-sm'
                  : 'text-white/50 hover:text-white/70'
              }`}
            >
              <span className="flex items-center justify-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                Agent
              </span>
            </button>
          </div>
        </div>}

        {!isMobile ? (
          /* Desktop: side-by-side columns */
          <div className="flex flex-1 flex-row min-h-0">
            {/* User Notebook (left) */}
            <div className="flex-1 flex flex-col min-h-0 border-r border-white/5">
              <div className="flex-1 overflow-y-auto px-4 py-3">
                <NotebookEntryComposer
                  onSubmit={handleCreateUserEntry}
                  placeholder="Write a note..."
                  onOpenLinkPicker={handleComposerOpenLinkPicker}
                  pendingLinks={composerLinks}
                  onRemovePendingLink={handleRemoveComposerLink}
                />
                <div className="mt-4 space-y-4">
                  {renderEntries(userNotebooks.entries, 'user')}
                </div>
              </div>
            </div>

            {/* Agent Notebook (right) */}
            <div className="flex-1 flex flex-col min-h-0 bg-purple-500/[0.01]">
              <div className="flex-1 overflow-y-auto px-4 py-3">
                {agentNotebooks.entries.length === 0 ? (
                  <div className="text-center text-white/30 text-sm py-8">
                    Agent hasn't written anything yet
                    <div className="text-xs mt-1">Notes will appear here after review</div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {renderEntries(agentNotebooks.entries, 'agent')}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          /* Mobile: single column with tab switching */
          <div className="flex-1 flex flex-col min-h-0 w-full">
            {mobileNotebookTab === 'user' ? (
              <div className="flex-1 flex flex-col min-h-0 w-full">
                <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 w-full">
                  <NotebookEntryComposer
                    onSubmit={handleCreateUserEntry}
                    placeholder="Write a note..."
                    onOpenLinkPicker={handleComposerOpenLinkPicker}
                    pendingLinks={composerLinks}
                    onRemovePendingLink={handleRemoveComposerLink}
                  />
                  <div className="mt-4 space-y-4">
                    {renderEntries(userNotebooks.entries, 'user')}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col min-h-0 w-full bg-purple-500/[0.01]">
                <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 w-full">
                  {agentNotebooks.entries.length === 0 ? (
                    <div className="text-center text-white/30 text-sm py-8">
                      Agent hasn't written anything yet
                      <div className="text-xs mt-1">Notes will appear here after review</div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {renderEntries(agentNotebooks.entries, 'agent')}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Link Pickers */}
      {linkPickerOpen && linkPickerType === 'chat' && (
        <ChatLinkPicker
          chats={chats}
          filterText={filterText}
          onSelect={handleLinkSelect}
          onClose={closeLinkPicker}
          anchorRect={linkPickerAnchor}
        />
      )}
      {linkPickerOpen && linkPickerType === 'notebook' && (
        <NotebookLinkPicker
          userNotebooks={userNotebooks}
          agentNotebooks={agentNotebooks}
          filterText={filterText}
          onSelect={handleLinkSelect}
          onClose={closeLinkPicker}
          anchorRect={linkPickerAnchor}
        />
      )}
    </div>
  );
}

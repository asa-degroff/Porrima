import { useState, useCallback, useEffect } from "react";
import type { NotebookEntry, NotebookIndex, NotebookLink, ChatListItem, ImageAttachment } from "../types";
import { fetchNotebookEntry } from "../api/client";
import { NotebookEntryComposer } from "./NotebookEntryComposer";
import { NotebookEntryDisplay } from "./NotebookEntryDisplay";
import { ChatLinkPicker } from "./ChatLinkPicker";
import { NotebookLinkPicker } from "./NotebookLinkPicker";

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
  onTriggerAgentReview: () => Promise<{ skipped?: boolean; reason?: string } | NotebookEntry>;
  chats: ChatListItem[];
  onChatSelect: (chatId: string) => void;
  onVisible?: () => void;
  onOpenSidebar?: () => void;
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
  onTriggerAgentReview,
  chats,
  onChatSelect,
  onVisible,
  onOpenSidebar,
}: Props) {
  const [fullEntries, setFullEntries] = useState<Record<string, NotebookEntry>>({});
  const [editingEntry, setEditingEntry] = useState<{ author: 'user' | 'agent'; id: string; content: string } | null>(null);
  const [composerLinks, setComposerLinks] = useState<NotebookLink>({});

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

  // Fetch full entry content for all index entries
  useEffect(() => {
    const allIndexEntries = [...userNotebooks.entries, ...agentNotebooks.entries];
    const missing = allIndexEntries.filter(e => !fullEntries[e.id]);
    if (missing.length === 0) return;

    Promise.all(
      missing.map(async (e) => {
        try {
          return await fetchNotebookEntry(e.author, e.id);
        } catch {
          return null;
        }
      })
    ).then((results) => {
      setFullEntries(prev => {
        const next = { ...prev };
        for (const entry of results) {
          if (entry) next[entry.id] = entry;
        }
        return next;
      });
    });
  }, [userNotebooks.entries, agentNotebooks.entries]);

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
      const entry = fullEntries[entryInfo.id] || {
        id: entryInfo.id,
        createdAt: entryInfo.createdAt,
        author: entryInfo.author,
        content: entryInfo.preview,
      };

      return (
        <div key={entry.id} id={`entry-${entry.id}`} className="mb-4">
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
              onEdit={author === 'user' ? () => handleEdit(author, entry.id, entry.content) : undefined}
              onDelete={() => handleDelete(author, entry.id)}
              onLinkClick={handleEntryLinkClick}
              onChatLinkClick={handleChatLinkClick}
              onAddLink={author === 'user' ? (type: 'chat' | 'notebook', anchorRect) => openLinkPicker(type, anchorRect, entry.id, author) : undefined}
              onRemoveLink={author === 'user' ? (linkType, index) => handleRemoveLink(entry.id, author, linkType, index) : undefined}
            />
          )}
        </div>
      );
    });
  }, [fullEntries, editingEntry, handleEdit, handleSaveEdit, handleDelete, handleEntryLinkClick, handleChatLinkClick, openLinkPicker, handleRemoveLink]);

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
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="px-3 md:px-6 py-3 border-b border-white/10 flex items-center justify-between gap-3 backdrop-blur-sm bg-white/[0.03]">
        <div className="flex items-center gap-2 min-w-0">
          {/* Hamburger menu - mobile only */}
          <button
            onClick={onOpenSidebar}
            className="md:hidden text-white/50 hover:text-white/80 transition-colors p-1 rounded-lg hover:bg-white/5 shrink-0"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <h2 className="text-sm font-medium text-white/80 truncate">Notebooks</h2>
        </div>
        <button
          onClick={handleTriggerAgent}
          className="px-3 py-1.5 text-xs rounded-lg transition-colors bg-purple-500/15 border border-purple-400/25 text-purple-300 font-medium hover:bg-purple-500/25"
          title="Trigger agent review of today's notes"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline mr-1">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          Review Notes
        </button>
      </div>

      {/* Content - Side by side on desktop, stacked on mobile */}
      <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
        {/* User Notebook (left) */}
        <div className="flex-1 flex flex-col min-h-0 border-r md:border-r border-white/5 overflow-hidden">
          <div className="px-3 py-2 border-b border-white/5 bg-white/[0.02]">
            <h3 className="text-xs font-medium text-white/60 uppercase tracking-wider">Your Notebook</h3>
          </div>
          <div className="flex-1 overflow-y-auto px-3 md:px-4 py-3">
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
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-purple-500/[0.01]">
          <div className="px-3 py-2 border-b border-white/5 bg-white/[0.02]">
            <h3 className="text-xs font-medium text-white/60 uppercase tracking-wider flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-purple-400" />
              Agent Notebook
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto px-3 md:px-4 py-3">
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

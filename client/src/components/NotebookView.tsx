import { useState, useCallback, useEffect } from "react";
import type { NotebookEntry, NotebookIndex, NotebookLink, ChatListItem } from "../types";
import { fetchNotebookEntry } from "../api/client";
import { NotebookEntryComposer } from "./NotebookEntryComposer";
import { NotebookEntryDisplay } from "./NotebookEntryDisplay";

interface Props {
  userNotebooks: NotebookIndex;
  agentNotebooks: NotebookIndex;
  loading?: boolean;
  error?: string | null;
  onCreateUserEntry: (content: string) => Promise<void>;
  onCreateAgentEntry: (content: string) => Promise<void>;
  onUpdateEntry: (author: 'user' | 'agent', id: string, updates: { content?: string; links?: NotebookLink }) => Promise<void>;
  onDeleteEntry: (author: 'user' | 'agent', id: string) => Promise<void>;
  onTriggerAgentReview: () => Promise<{ skipped?: boolean; reason?: string } | NotebookEntry>;
  chats: ChatListItem[];
  onChatSelect: (chatId: string) => void;
  onVisible?: () => void;
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
}: Props) {
  const [fullEntries, setFullEntries] = useState<Record<string, NotebookEntry>>({});
  const [editingEntry, setEditingEntry] = useState<{ author: 'user' | 'agent'; id: string; content: string } | null>(null);

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
          const full = await fetchNotebookEntry(e.author, e.id);
          return full;
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

  const handleCreateUserEntry = useCallback(async (content: string) => {
    await onCreateUserEntry(content);
  }, [onCreateUserEntry]);

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

  const handleEntryLinkClick = useCallback((author: 'user' | 'agent', entryId: string) => {
    const element = document.getElementById(`entry-${entryId}`);
    element?.scrollIntoView({ behavior: 'smooth' });
    element?.classList.add('ring-2', 'ring-purple-400');
    setTimeout(() => element?.classList.remove('ring-2', 'ring-purple-400'), 2000);
  }, []);

  const handleChatLinkClick = useCallback((chatId: string) => {
    onChatSelect(chatId);
  }, [onChatSelect]);

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
            />
          )}
        </div>
      );
    });
  }, [fullEntries, editingEntry, handleEdit, handleSaveEdit, handleDelete, handleEntryLinkClick, handleChatLinkClick]);

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
        <h2 className="text-sm font-medium text-white/80">Notebooks</h2>
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
            <NotebookEntryComposer onSubmit={handleCreateUserEntry} placeholder="Write a note..." />
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
    </div>
  );
}

import { useCallback } from "react";
import type { NotebookIndex } from "../types";

interface Props {
  userNotebooks: NotebookIndex;
  agentNotebooks: NotebookIndex;
  filterText: string;
  onSelect: (entryId: string, author: 'user' | 'agent', preview: string) => void;
  onClose: () => void;
  anchorRect: DOMRect | null;
}

export function NotebookLinkPicker({ userNotebooks, agentNotebooks, filterText, onSelect, onClose, anchorRect }: Props) {
  const allEntries = [...userNotebooks.entries, ...agentNotebooks.entries];
  const filtered = allEntries.filter(e =>
    e.preview.toLowerCase().includes(filterText.toLowerCase())
  ).slice(0, 10);

  const handleSelect = useCallback((entry: typeof filtered[0]) => {
    onSelect(entry.id, entry.author, entry.preview);
    onClose();
  }, [onSelect, onClose]);

  const position = anchorRect ? {
    top: anchorRect.bottom + window.scrollY + 4,
    left: anchorRect.left + window.scrollX,
  } : { top: 100, left: 100 };

  return (
    <div
      className="link-picker-popup fixed z-50 w-80 max-h-96 overflow-auto rounded-lg border border-white/10 app-solid-popover shadow-xl"
      style={position}
    >
      <div className="px-3 py-2 border-b border-white/10">
        <h4 className="text-xs font-medium text-white/60 uppercase tracking-wider">Link to Notebook Entry</h4>
      </div>
      {filtered.length === 0 ? (
        <div className="px-4 py-3 text-sm text-white/40">
          No entries match "{filterText}"
        </div>
      ) : (
        <div className="py-1">
          {filtered.map((entry) => (
            <button
              key={entry.id}
              onClick={() => handleSelect(entry)}
              className="w-full px-4 py-2 text-left text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors flex flex-col gap-1"
            >
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${entry.author === 'agent' ? 'bg-purple-400' : 'bg-white/40'}`} />
                <span className="font-medium truncate flex-1">{entry.author === 'agent' ? 'Agent' : 'User'}: {entry.preview}</span>
              </div>
              <span className="text-xs text-white/30 truncate pl-4">{new Date(entry.createdAt).toLocaleDateString()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

# Notebook Link Picker Implementation

**Date:** March 15, 2026  
**Status:** ✅ Complete  
**Issue Closed:** #80 (delete confirmation)

---

## What Was Implemented

### 1. Delete Confirmation

**Component:** `NotebookEntryDisplay.tsx`  
**Change:** Added `window.confirm()` before delete

```typescript
{onDelete && (
  <button
    onClick={() => {
      if (window.confirm("Delete this entry? This cannot be undone.")) {
        onDelete(entry.id);
      }
    }}
    // ...
  >
    // delete icon
  </button>
)}
```

**Behavior:**
- Shows native browser confirm dialog
- Message: "Delete this entry? This cannot be undone."
- Only deletes if user confirms

---

### 2. Link Picker Integration

**Components:**
- `NotebookEntryDisplay.tsx` - Added "Add link" button
- `NotebookView.tsx` - Link picker state + handlers
- `ChatLinkPicker.tsx` - Chat selection popup
- `NotebookLinkPicker.tsx` - Notebook entry selection popup

#### NotebookEntryDisplay Changes

**New Props:**
```typescript
interface Props {
  // ... existing
  onAddLink?: (type: 'chat' | 'notebook', anchorRect: DOMRect) => void;
}
```

**Add Link Button:**
```typescript
{onAddLink && (
  <div className="mt-3">
    <button
      ref={linkButtonRef}
      onClick={handleAddLink}
      className="text-xs px-2 py-1 rounded bg-white/5 border border-dashed border-white/20 text-white/40 hover:text-white/60 hover:bg-white/10"
    >
      <svg>...</svg>
      Add link
    </button>
  </div>
)}
```

**Behavior:**
- Only shows on user entries (not agent)
- Dashed border indicates it's an action button
- Positioned below existing links
- Opens picker on click

#### NotebookView Changes

**New State:**
```typescript
const [linkPickerOpen, setLinkPickerOpen] = useState(false);
const [linkPickerType, setLinkPickerType] = useState<'chat' | 'notebook' | null>(null);
const [linkPickerAnchor, setLinkPickerAnchor] = useState<DOMRect | null>(null);
const [pendingLink, setPendingLink] = useState<{ entryId: string; author: 'user' | 'agent' } | null>(null);
const [filterText, setFilterText] = useState('');
```

**Handlers:**
```typescript
const openLinkPicker = useCallback((type, anchorRect, entryId, author) => {
  setLinkPickerType(type);
  setLinkPickerAnchor(anchorRect);
  setPendingLink({ entryId, author });
  setFilterText('');
  setLinkPickerOpen(true);
});

const handleLinkSelect = useCallback(async (targetId, targetAuthorOrTitle, preview) => {
  if (!pendingLink) return;
  
  const links: NotebookLink = {};
  if (linkPickerType === 'chat') {
    links.chats = [{ chatId: targetId, title: preview || targetAuthorOrTitle }];
  } else {
    links.notebooks = [{ entryId: targetId, author: targetAuthorOrTitle }];
  }
  
  await onUpdateEntry(pendingLink.author, pendingLink.entryId, { links });
  setLinkPickerOpen(false);
  setLinkPickerType(null);
  setPendingLink(null);
}, [pendingLink, linkPickerType, onUpdateEntry]);
```

**Render:**
```typescript
{renderEntries(userNotebooks.entries, 'user')}
// ...
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
```

---

### 3. Picker Components

#### ChatLinkPicker

**Props:**
```typescript
interface Props {
  chats: ChatListItem[];
  filterText: string;
  onSelect: (chatId: string, chatTitle: string, preview?: string) => void;
  onClose: () => void;
  anchorRect: DOMRect | null;
}
```

**Features:**
- Filters chats by title (case-insensitive)
- Shows first 10 matches
- Displays chat type badge (purple for agent, blue for quick)
- Shows preview text in callback
- Positioned at anchorRect (button location)

#### NotebookLinkPicker

**Props:**
```typescript
interface Props {
  userNotebooks: NotebookIndex;
  agentNotebooks: NotebookIndex;
  filterText: string;
  onSelect: (entryId: string, author: 'user' | 'agent', preview: string) => void;
  onClose: () => void;
  anchorRect: DOMRect | null;
}
```

**Features:**
- Combines user + agent entries
- Filters by preview text (case-insensitive)
- Shows first 10 matches
- Displays author badge (purple for agent, white for user)
- Positioned at anchorRect

---

## User Flow

### Adding a Link

1. User views their notebook entry
2. Clicks "Add link" button (dashed border, below content)
3. **Future enhancement:** Type `[[` or select from dropdown to choose chat vs notebook
4. Picker popup appears at button location
5. Filter by typing (optional)
6. Click desired chat or notebook entry
7. Link saved via PATCH /api/notebooks/:author/:id
8. Link appears in entry's link section

### Viewing Links

- **Chat links:** 💬 Chat title (clickable → navigates to chat)
- **Notebook links:** 📓 user's/agent's entry (clickable → scrolls to entry)

---

## Technical Details

### Link Structure

```typescript
interface NotebookLink {
  notebooks?: { entryId: string; author: 'user' | 'agent' }[];
  chats?: { chatId: string; title?: string }[];
}
```

### API Call

```typescript
PATCH /api/notebooks/user/:id
{
  "links": {
    "chats": [{ "chatId": "abc123", "title": "Debugging session" }],
    "notebooks": [{ "entryId": "xyz789", "author": "agent" }]
  }
}
```

### Positioning

Pickers use `position: fixed` with coordinates from `anchorRect`:
```typescript
const position = anchorRect ? {
  top: anchorRect.bottom + window.scrollY + 4,
  left: anchorRect.left + window.scrollX,
} : { top: 100, left: 100 };
```

Ensures picker appears directly below the "Add link" button.

---

## Future Enhancements

### 1. Inline Trigger (`[[` autocomplete)

Current: Requires clicking "Add link" button  
Future: Type `[[` to open picker with autocomplete

```typescript
// In NotebookEntryComposer
const handleKeyDown = useCallback((e) => {
  if (e.key === '[' && e.ctrlKey) {
    // Open link picker
  }
}, []);
```

### 2. Link Type Selection

Current: Opens chat picker by default (hardcoded in `handleAddLink`)  
Future: Show menu to choose chat vs notebook first

```typescript
const handleAddLink = useCallback(() => {
  // Show small menu: "Link to chat" | "Link to notebook"
  // Then open appropriate picker
}, []);
```

### 3. Filter Input in Picker

Current: Filter text state exists but no UI input  
Future: Add input field at top of picker

```typescript
<input
  type="text"
  value={filterText}
  onChange={(e) => setFilterText(e.target.value)}
  placeholder="Filter..."
  className="..."
/>
```

### 4. Link Preview on Hover

Show tooltip with full title/preview when hovering over link chips.

---

## Testing Checklist

- [ ] Click "Add link" button on user entry
- [ ] Verify picker opens at button location
- [ ] Select a chat → link appears in entry
- [ ] Select a notebook entry → link appears in entry
- [ ] Click chat link → navigates to chat
- [ ] Click notebook link → scrolls to entry
- [ ] Delete entry → confirm dialog shows
- [ ] Cancel delete → entry preserved
- [ ] Confirm delete → entry removed

---

## Build Status

```bash
cd client && npm run build
# ✓ built in 924ms
# dist/assets/index-iuDWf26Z.js  350.37 kB │ gzip: 100.26 kB
```

✅ TypeScript passes  
✅ Build succeeds  
✅ All components type-safe

# Skill Invocation Enhancement

## Overview
Expanded skill invocation to allow `/` commands from any position in the message, not just at the start.

## Changes

### Frontend (`client/src/`)

#### MessageInput.tsx
- **Updated `onSlashTyping` callback signature**: Now accepts `filterText: string` and `cursorRect?: DOMRect` parameters
- **Modified `handleKeyDown`**: Removed the `textRef.current.trim() === ""` condition, allowing `/` to trigger from any position
- **Enhanced `handleInput`**: 
  - Tracks cursor position relative to `/` characters
  - Only shows skill selector when cursor is after a `/`
  - Updates filter text dynamically as user types after `/`
  - Properly closes selector when cursor moves away from `/` context

#### ChatView.tsx
- **Updated `handleSlashTyping`**: Now accepts filter text and cursor position, positions selector at cursor location
- **Removed unused `getPartialSkillText` and `handleSkillSelect` callbacks**
- **Skill selector positioning**: Uses cursor rect instead of input rect for better positioning

#### SkillSelector.tsx
- **Positioning refinement**: Added 4px offset below cursor for better visual spacing

### Backend (`server/src/services/skills.ts`)

#### `parseSkillInvocations`
- **Improved regex**: Changed from `/\/([a-zA-Z0-9\-_]+)(?:\s|$)/g` to `/(?:^|(?<=\s))\/([a-zA-Z0-9\-_]+)(?=\s|$)/g`
- **Benefits**:
  - Requires `/` to be preceded by whitespace or start of string
  - Prevents false positives like `user/name` being parsed as skill invocation
  - Uses lookahead to avoid consuming whitespace, allowing consecutive skills like `/one /two /three`

#### `stripSkillInvocations`
- **Updated regex**: Matches the improved pattern from `parseSkillInvocations`
- **Better whitespace handling**: Normalizes multiple spaces after stripping

## User Experience

### Before
- `/` only worked at the start of a message
- User had to start a new message to invoke a skill
- Limited flexibility in combining skills with regular text

### After
- `/` works from any position in the message
- Natural typing flow: "Let me check /python how to do this"
- Multiple skills can be invoked in a single message
- Non-matching text after `/` is treated as normal text (e.g., "/xyz" that doesn't match any skill stays as text)
- Better regex prevents accidental skill detection in paths like `user/name`

## Example Flows

1. **Start of message**: `/python hello` → invokes python skill, sends "hello"
2. **Middle of message**: `let me try /python this` → invokes python skill, sends "let me try this"
3. **Multiple skills**: `check /py and /js` → invokes both skills, sends "check and"
4. **Non-matching**: `user/name is fine` → no skill invoked, text preserved
5. **Partial typing**: User types `/py`, sees selector, continues typing `thon` to filter, selects `python` → chip inserted

## Technical Details

### Cursor Tracking
The implementation uses `window.getSelection()` and `Range` APIs to:
- Get cursor position in the contentEditable div
- Calculate text from start to cursor
- Find the last `/` before cursor
- Extract filter text after that `/`
- Get cursor rect for positioning the selector

### Skill Chip Insertion
When a skill is selected:
1. Get text before the `/`
2. Clear editor content
3. Preserve non-text nodes (images, etc.)
4. Insert text before `/`
5. Insert skill chip element
6. Add trailing space
7. Position cursor after the chip
8. Trigger input event to update state

### Selector Lifecycle
- **Open**: When `/` is typed and cursor is after it
- **Update**: As user types, filter text and position update
- **Close**: When cursor moves away from `/`, skill is selected, or Escape is pressed

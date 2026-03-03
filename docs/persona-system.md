# Persona System — Technical Documentation

A stable identity layer for the qu.je Agent, separate from the episodic memory system.

---

## Overview

The persona system defines the agent's core identity, communication style, values, and behavioral traits. Unlike memories (which capture specific, episodic facts about the user), the persona represents the agent's stable personality that persists across all interactions.

### Key Design Principles

1. **Separation of Concerns**: Persona is identity; memory is knowledge. They serve different purposes.
2. **Stability Over Volatility**: Persona changes infrequently, only for significant recurring patterns.
3. **Synthesis-Driven Evolution**: Persona updates happen during daily synthesis, not in real-time.
4. **Versioned History**: Every change is backed up for audit and rollback.

---

## Architecture

### File Structure

```
~/.quje-agent/
├── persona.md                    # Current persona document
└── persona-history/
    ├── CHANGELOG.md              # Log of all persona changes
    ├── persona-2025-01-15T...md  # Historical versions (timestamped)
    └── ...
```

### Components

| File | Purpose |
|------|---------|
| `server/src/services/persona-store.ts` | File-based storage with versioning |
| `server/src/routes/persona.ts` | REST API for persona CRUD |
| `server/src/services/memory-context.ts` | Injects persona into system prompt |
| `server/src/services/synthesis.ts` | Analyzes memories for persona promotion |
| `server/src/services/memory-tools.ts` | `update_persona` tool for agent use |

---

## Persona Document Structure

The default persona is a Markdown document with these sections:

```markdown
# Agent Persona

## Core Identity
- Name, role, purpose

## Communication Style
- Tone, formality, verbosity, humor

## Values & Principles
- Guiding principles for decision-making

## Knowledge Domains
- Primary/secondary expertise, learning stance

## Behavioral Traits
- Curiosity, risk tolerance, creativity

## Interaction Patterns
- Handling uncertainty, mistakes, user correction
```

Sections can be added, removed, or modified as needed.

---

## How It Works

### 1. Initialization

On server startup, `initializePersona()` checks for `~/.quje-agent/persona.md`. If missing, it creates the default template.

### 2. Context Augmentation

Before each agent chat response, `buildMemoryAugmentedPrompt()` loads the persona and injects it into the system prompt:

```
[Base System Prompt]
[Your Persona section]
[What you remember about this user section]
```

The persona is loaded fresh every time, ensuring the agent always acts consistently with its current identity.

### 3. Updates via Tool

The agent can call the `update_persona` tool during conversations:

```json
{
  "name": "update_persona",
  "arguments": {
    "section": "Communication Style",
    "content": "- **Tone:** Warm and professional, with occasional humor when appropriate",
    "reason": "User has consistently responded positively to this communication style across 50+ interactions"
  }
}
```

The tool:
- Validates all required fields
- Loads current persona
- Updates (or appends) the specified section
- Saves with automatic backup to history

### 4. Synthesis-Driven Promotion

During daily synthesis (Step 4), the system analyzes memories for recurring patterns:

1. **Filter candidates**: High-importance (≥7) memories with multiple accesses (≥2)
2. **Cluster by similarity**: Group similar memories using cosine similarity (>0.85)
3. **Identify significant patterns**: Clusters with ≥3 members
4. **Generate suggestions**: LLM proposes persona updates based on each cluster

These suggestions are logged to the daily synthesis report. Future versions could auto-apply conservative updates or present them to the user for approval.

---

## REST API

### `GET /api/persona`
Get the current persona document.

**Response:**
```json
{
  "content": "# Agent Persona\n\n...",
  "lastModified": "2025-01-15T10:30:00.000Z",
  "path": "/home/user/.quje-agent/persona.md"
}
```

### `PUT /api/persona`
Update the entire persona document.

**Body:**
```json
{
  "content": "# Agent Persona\n\n...",
  "reason": "Manual update via UI"
}
```

### `GET /api/persona/history`
List all historical persona versions.

**Response:**
```json
{
  "versions": [
    "persona-2025-01-15T10-30-00-000Z.md",
    "persona-2025-01-10T08-15-00-000Z.md"
  ]
}
```

### `GET /api/persona/history/:filename`
Get a specific historical version.

**Response:**
```json
{
  "filename": "persona-2025-01-10T08-15-00-000Z.md",
  "content": "# Agent Persona\n\n..."
}
```

---

## Tool: `update_persona`

Available to the agent during tool use.

### Parameters

| Field | Type | Description |
|-------|------|-------------|
| `section` | string | The persona section to update (e.g., "Communication Style") |
| `content` | string | The new content for this section |
| `reason` | string | Why this change is being made |

### Behavior

- If the section exists, its content is replaced
- If the section doesn't exist, it's appended to the document
- A backup is automatically created in `persona-history/`
- The change is logged to `CHANGELOG.md`

### Example Usage

The agent might call this after noticing a pattern:

> "I've noticed the user consistently prefers concise, bulleted responses over long explanations. I should update my persona to reflect this preference as a core communication trait."

```json
{
  "name": "update_persona",
  "arguments": {
    "section": "Communication Style",
    "content": "- **Verbosity:** Concise—prefers bulleted lists and brief explanations over detailed prose",
    "reason": "User has repeatedly requested concise responses"
  }
}
```

---

## Memory vs. Persona

| Aspect | Memory | Persona |
|--------|--------|---------|
| **Purpose** | Episodic facts about the user | Agent's core identity |
| **Volatility** | Changes frequently | Changes rarely |
| **Update Trigger** | Every conversation | Synthesis cycles or explicit tool calls |
| **Storage** | SQLite with embeddings | Markdown file |
| **Examples** | "User prefers TypeScript", "User works in Sydney" | "I am helpful and precise", "I ask clarifying questions" |
| **Access Pattern** | Semantic search + scoring | Always loaded in full |

### When to Use Each

**Save to Memory:**
- User-specific preferences ("User likes dark mode")
- Biographical facts ("User's name is Alex")
- Session-specific instructions ("Explain code before writing it")

**Update Persona:**
- Recurring interaction patterns that should shape agent behavior
- Traits that apply universally, not just to this user
- Core identity elements that define "who the agent is"

---

## Future Enhancements

1. **UI for Persona Editing**: Visual editor in the web interface
2. **Approval Workflow**: Agent proposes persona changes, user approves
3. **Persona Presets**: Load different personas for different contexts
4. **Multi-User Support**: User-specific persona adaptations
5. **Automatic Pattern Application**: Auto-apply conservative persona updates from synthesis
6. **Persona Analytics**: Track which persona traits are most/least used

---

## File Map

```
server/src/
├── routes/
│   └── persona.ts                    # REST API endpoints
└── services/
    ├── persona-store.ts              # File storage with versioning
    ├── memory-context.ts             # Persona injection into prompts
    ├── synthesis.ts                  # Pattern detection for persona promotion
    └── memory-tools.ts               # update_persona tool implementation

~/.quje-agent/
├── persona.md                        # Current persona
└── persona-history/
    ├── CHANGELOG.md
    └── persona-*.md                  # Version backups
```

---

## Code Examples

### Loading Persona Programmatically

```typescript
import { loadPersona } from "./services/persona-store.js";

const persona = await loadPersona();
console.log(persona.content);
console.log(persona.lastModified);
```

### Updating Persona

```typescript
import { savePersona } from "./services/persona-store.js";

const updatedContent = await updateSection(currentPersona, "Values", "New content");
await savePersona(updatedContent, "Updated values based on user feedback");
```

### Accessing History

```typescript
import { listPersonaHistory, getPersonaVersion } from "./services/persona-store.js";

const versions = await listPersonaHistory();
const oldPersona = await getPersonaVersion(versions[0]);
```

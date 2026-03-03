# Persona System — Quick Reference

## At a Glance

**Purpose**: Stable identity layer for the agent  
**Location**: `~/.quje-agent/persona.md`  
**Updates**: During synthesis or via `update_persona` tool  
**Philosophy**: Memory = knowledge, Persona = identity

---

## File Structure

```
~/.quje-agent/
├── persona.md               # Current persona (edit this)
└── persona-history/
    ├── CHANGELOG.md         # All changes with reasons
    └── persona-*.md         # Timestamped backups
```

---

## Default Persona Sections

```markdown
# Agent Persona

## Core Identity
- Name, role, purpose

## Communication Style
- Tone, formality, verbosity, humor

## Values & Principles
- Decision-making guidelines

## Knowledge Domains
- Expertise areas, learning approach

## Behavioral Traits
- Curiosity, risk tolerance, creativity

## Interaction Patterns
- Handling uncertainty, mistakes, feedback
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/persona` | Get current persona |
| `PUT` | `/api/persona` | Update entire persona |
| `GET` | `/api/persona/history` | List versions |
| `GET` | `/api/persona/history/:file` | Get specific version |

---

## Tool: `update_persona`

**Parameters**:
- `section`: Section name (e.g., "Communication Style")
- `content`: New section content
- `reason`: Why this change

**Example**:
```json
{
  "name": "update_persona",
  "arguments": {
    "section": "Communication Style",
    "content": "- **Tone:** Concise and direct",
    "reason": "User prefers brevity over detailed explanations"
  }
}
```

---

## When to Update Persona vs. Memory

| Update Persona | Save to Memory |
|----------------|----------------|
| Recurring patterns (3+ times) | Single occurrence |
| Agent identity/behavior | User-specific facts |
| Universal traits | Specific preferences |
| Stable, long-term | Volatile, contextual |

**Examples**:

✅ **Persona**: "I ask clarifying questions before making assumptions"  
✅ **Memory**: "User prefers TypeScript over JavaScript"

✅ **Persona**: "I provide multiple solution paths with trade-offs"  
✅ **Memory**: "User is building a real-time chat application"

---

## Synthesis Pattern Detection

**Occurs**: Daily, during synthesis  
**Threshold**: 3+ similar memories with importance ≥7  
**Output**: Suggestion logged to daily report

**Process**:
1. Filter high-importance, frequently-accessed memories
2. Cluster by semantic similarity (>0.85)
3. Identify clusters with ≥3 members
4. LLM generates persona update suggestion
5. Logged for review (future: auto-apply or approve)

---

## Editing Persona

### Method 1: Direct File Edit
```bash
nano ~/.quje-agent/persona.md
# No backup needed—system creates one on next save
```

### Method 2: Via API
```bash
curl -X PUT http://localhost:3001/api/persona \
  -H "Content-Type: application/json" \
  -d '{"content":"# Agent Persona\n...","reason":"Manual update"}'
```

### Method 3: Via Agent Tool
Agent calls `update_persona` during conversation

### Method 4: Via Synthesis (Suggestions Only)
Review daily synthesis log for suggestions

---

## Rollback to Previous Version

```bash
# List versions
curl http://localhost:3001/api/persona/history

# Get specific version
curl http://localhost:3001/api/persona/history/persona-2025-01-10T....md

# Restore (copy content and PUT)
curl -X PUT http://localhost:3001/api/persona \
  -H "Content-Type: application/json" \
  -d '{"content":"<paste old content>","reason":"Rollback to previous version"}'
```

---

## Troubleshooting

**Persona not appearing in chats**:
- Check `~/.quje-agent/persona.md` exists
- Verify server started without errors
- Check logs for persona load failures

**Tool not available**:
- Ensure you're using agent-type chat (not quick chat)
- Verify `update_persona` in tool definitions

**Backup not created**:
- Check `~/.quje-agent/persona-history/` directory
- Verify write permissions

---

## Key Files

| File | Purpose |
|------|---------|
| `server/src/services/persona-store.ts` | Storage logic |
| `server/src/routes/persona.ts` | REST API |
| `server/src/services/memory-context.ts` | Prompt injection |
| `server/src/services/synthesis.ts` | Pattern detection |
| `server/src/services/memory-tools.ts` | Tool implementation |

---

## Best Practices

1. **Be Conservative**: Only update persona for significant, recurring patterns
2. **Provide Reasons**: Always document why changes are made
3. **Review History**: Check changelog before making major changes
4. **Test Incrementally**: Make small changes, observe behavior
5. **Separate Concerns**: Don't duplicate memories in persona

---

## See Also

- Full documentation: `docs/persona-system.md`
- Implementation summary: `docs/persona-implementation-summary.md`
- Memory system: `docs/memory-system.md`

# Persona System Setup & Testing

## Quick Start

### 1. Set Up Development Token (Required for CLI Access)

The persona API requires authentication. For development/testing, use a bearer token:

```bash
# Option A: Set in current terminal
export QUJE_DEV_TOKEN=$(openssl rand -hex 16)
echo "Token: $QUJE_DEV_TOKEN"

# Option B: Add to .env file (persistent)
cat > .env << EOF
QUJE_DEV_TOKEN=$(openssl rand -hex 16)
EOF
```

### 2. Start the Server

```bash
cd /home/asa/quje-agent
npm run dev
```

Wait for the server to start and initialize the persona system. You should see:
```
[persona] Created default persona.md
```

### 3. Verify Persona Initialization

```bash
# Test API access
curl -H "Authorization: Bearer $QUJE_DEV_TOKEN" http://localhost:3001/api/persona

# Or run the automated test suite
export QUJE_DEV_TOKEN=your-token-here  # if not already set
./scripts/test-persona.sh
```

### 4. Edit Your Persona

The default persona is created at `~/.quje-agent/persona.md`. Edit it directly:

```bash
nano ~/.quje-agent/persona.md
# or
code ~/.quje-agent/persona.md
```

Or update via API:

```bash
curl -H "Authorization: Bearer $QUJE_DEV_TOKEN" \
  -H "Content-Type: application/json" \
  -X PUT http://localhost:3001/api/persona \
  -d '{
    "content": "# Agent Persona\n\n## Core Identity\n- **Name:** Your Custom Agent\n...",
    "reason": "Customized agent personality"
  }'
```

## Testing in Chat

1. Open http://localhost:5174 in your browser
2. Start a new chat (agent type, not quick chat)
3. Send a message
4. View the prompt to see persona injected:
   - Check the network tab for the chat response
   - Or enable debug logging to see the augmented system prompt

The persona should appear between the base system prompt and memories section.

## Verifying Persona Evolution

After a few conversations, check the daily synthesis logs:

```bash
ls -la ~/.quje-agent/memory/daily/
cat ~/.quje-agent/memory/daily/$(date +%Y-%m-%d).md
```

Look for "Persona pattern suggestion" entries when patterns are detected.

## API Reference

### Get Current Persona
```bash
curl -H "Authorization: Bearer $QUJE_DEV_TOKEN" \
  http://localhost:3001/api/persona
```

### Update Persona
```bash
curl -H "Authorization: Bearer $QUJE_DEV_TOKEN" \
  -H "Content-Type: application/json" \
  -X PUT http://localhost:3001/api/persona \
  -d '{"content":"...","reason":"..."}'
```

### View History
```bash
curl -H "Authorization: Bearer $QUJE_DEV_TOKEN" \
  http://localhost:3001/api/persona/history
```

### Get Specific Version
```bash
VERSION="persona-2025-01-15T10-30-00-000Z.md"
curl -H "Authorization: Bearer $QUJE_DEV_TOKEN" \
  http://localhost:3001/api/persona/history/$VERSION
```

## Troubleshooting

### "Authentication required" Error
- Set `QUJE_DEV_TOKEN` environment variable
- Restart the server after setting the token
- Token must match exactly (case-sensitive)

### Persona Not Appearing in Chats
- Verify you're using agent-type chat (not quick chat)
- Check server logs for persona load errors
- Confirm persona.md exists: `ls -la ~/.quje-agent/persona.md`

### Test Script Fails
- Ensure server is running on port 3001
- Check token is set: `echo $QUJE_DEV_TOKEN`
- Verify permissions: `chmod +x ./scripts/test-persona.sh`

## File Locations

```
~/.quje-agent/
├── persona.md                      # Current persona (edit this)
└── persona-history/
    ├── CHANGELOG.md                # Change log with reasons
    └── persona-*.md                # Version backups
```

## Next Steps

1. **Customize** the default persona to match your preferred agent personality
2. **Test** the `update_persona` tool in a chat conversation
3. **Monitor** synthesis logs for persona pattern suggestions
4. **Review** the full documentation in `docs/persona-system.md`

---

For detailed API reference and implementation details, see `docs/persona-system.md`.

#!/bin/bash

# Test script for persona system
# Run this after starting the server
# Requires QUJE_DEV_TOKEN to be set, or server running with QUJE_DEV_TOKEN env var

set -e

# Check for dev token
if [ -z "$QUJE_DEV_TOKEN" ]; then
  # Try to load from .env file if it exists
  if [ -f ".env" ]; then
    export QUJE_DEV_TOKEN=$(grep QUJE_DEV_TOKEN .env | cut -d'=' -f2)
  fi
fi

if [ -z "$QUJE_DEV_TOKEN" ]; then
  echo "⚠️  Warning: QUJE_DEV_TOKEN not set"
  echo "   Set it in your environment or .env file for API access"
  echo "   Example: export QUJE_DEV_TOKEN=test-token-123"
  echo ""
  echo "   Starting tests without auth (may fail if auth is required)..."
  echo ""
  AUTH_HEADER=""
else
  echo "✓ Using dev token for authentication"
  AUTH_HEADER="-H \"Authorization: Bearer $QUJE_DEV_TOKEN\""
fi

BASE_URL="http://localhost:3001/api"

echo "=== Persona System Test Suite ==="
echo ""

# Test 1: Get current persona
echo "Test 1: GET /api/persona"
response=$(curl -s $AUTH_HEADER "$BASE_URL/persona")
if echo "$response" | grep -q "content"; then
    echo "✅ PASS: Persona retrieved successfully"
    echo "   Path: $(echo "$response" | grep -o '"path":"[^"]*"' | cut -d'"' -f4)"
else
    echo "❌ FAIL: Could not retrieve persona"
    echo "   Response: $response"
    if echo "$response" | grep -q "Authentication required"; then
        echo "   → Auth error. Set QUJE_DEV_TOKEN environment variable"
    fi
    exit 1
fi
echo ""

# Test 2: Get persona history
echo "Test 2: GET /api/persona/history"
response=$(curl -s $AUTH_HEADER "$BASE_URL/persona/history")
if echo "$response" | grep -q "versions"; then
    echo "✅ PASS: History endpoint working"
    version_count=$(echo "$response" | grep -o '"versions":\[\]' | wc -l)
    echo "   Versions in history: $version_count (expected 0 for fresh install)"
else
    echo "❌ FAIL: History endpoint not working"
    echo "   Response: $response"
    exit 1
fi
echo ""

# Test 3: Update persona
echo "Test 3: PUT /api/persona"
test_content="# Agent Persona

## Core Identity
- **Name:** Porrima
- **Role:** Test persona for verification

## Communication Style
- **Tone:** Test tone - should be replaced after testing
- **Formality:** Professional

## Values & Principles
- Test value for verification

## Knowledge Domains
- Testing and verification

## Behavioral Traits
- Test trait

## Interaction Patterns
- Test pattern"

response=$(curl -s $AUTH_HEADER -X PUT "$BASE_URL/persona" \
  -H "Content-Type: application/json" \
  -d "{
    \"content\": $(echo "$test_content" | jq -Rs .),
    \"reason\": \"Test update from test-persona.sh script\"
  }")

if echo "$response" | grep -q "lastModified"; then
    echo "✅ PASS: Persona updated successfully"
    echo "   Backup should exist in persona-history/"
else
    echo "❌ FAIL: Could not update persona"
    echo "   Response: $response"
    exit 1
fi
echo ""

# Test 4: Verify backup was created
echo "Test 4: Check backup creation"
sleep 1  # Give file system time to write
response=$(curl -s $AUTH_HEADER "$BASE_URL/persona/history")
if echo "$response" | grep -q "persona-"; then
    echo "✅ PASS: Backup created in history"
    backup_name=$(echo "$response" | grep -o '"persona-[^"]*"' | head -1 | tr -d '"')
    echo "   Backup file: $backup_name"
else
    echo "⚠️  WARNING: No backup found (might be first update)"
fi
echo ""

# Test 5: Get specific version
echo "Test 5: GET /api/persona/history/:filename"
backup_name=$(curl -s $AUTH_HEADER "$BASE_URL/persona/history" | grep -o '"persona-[^"]*"' | head -1 | tr -d '"')
if [ -n "$backup_name" ]; then
    response=$(curl -s $AUTH_HEADER "$BASE_URL/persona/history/$backup_name")
    if echo "$response" | grep -q "content"; then
        echo "✅ PASS: Historical version retrievable"
    else
        echo "❌ FAIL: Could not retrieve historical version"
        exit 1
    fi
else
    echo "⚠️  SKIP: No backup to test"
fi
echo ""

# Test 6: Verify persona.md content
echo "Test 6: Verify persona.md file"
persona_file="$HOME/.quje-agent/persona.md"
if [ -f "$persona_file" ]; then
    echo "✅ PASS: persona.md exists at $persona_file"
    section_count=$(grep -c "^##" "$persona_file" || echo "0")
    echo "   Sections found: $section_count"
else
    echo "❌ FAIL: persona.md not found"
    exit 1
fi
echo ""

# Test 7: Check changelog
echo "Test 7: Check CHANGELOG.md"
changelog_file="$HOME/.quje-agent/persona-history/CHANGELOG.md"
if [ -f "$changelog_file" ]; then
    echo "✅ PASS: CHANGELOG.md exists"
    entry_count=$(grep -c "^#" "$changelog_file" || echo "0")
    echo "   Entries: $entry_count"
else
    echo "⚠️  WARNING: CHANGELOG.md not found (created on first update)"
fi
echo ""

echo "=== All Tests Complete ==="
echo ""
echo "Manual verification steps:"
echo "1. Check ~/.quje-agent/persona.md content"
echo "2. Check ~/.quje-agent/persona-history/ for backups"
echo "3. Start a chat and verify persona appears in prompt"
echo "4. Test update_persona tool in an agent chat"
echo ""

# Fixes Applied for generate_and_review

## Issue 1: Image Not Showing in UI ✅ FIXED

**Problem:** The injected user message with the image wasn't being saved to chat history, so it didn't appear in the UI.

**Fix:** Modified `getSteeringMessages()` to:
1. Create a proper `ChatMessage` with the image in the `images` array
2. Push it to `chat.messages` 
3. Call `saveChat()` to persist it
4. Then return the message for LLM consumption

**Code:**
```typescript
// Create the user message with image
const userMessageWithImage: ChatMessage = {
  role: "user",
  content: "Here's the generated image...",
  images: [{ data: injection.data, mimeType: injection.mimeType, name: `...` }],
  timestamp: Date.now(),
};

// Persist to chat history so it shows in UI
chat.messages.push(userMessageWithImage);
await saveChat(chat);
```

## Issue 2: Second Iteration Not Working 🔍 INVESTIGATING

**Problem:** When the agent calls `generate_and_review` again for a retry, the second iteration isn't being processed.

**Possible Causes:**
1. `pendingImageInjection` not being cleared properly between iterations
2. Tool result from second iteration not being captured
3. Agent loop not continuing after second tool completion

**Debug Logging Added:**
- Log when `pendingImageInjection` is set
- Log when `pendingImageInjection` is consumed
- Log if pendingImage is missing from tool result

**Next Steps:**
Test the fix and check logs for:
```
[chat] generate_and_review completed with pending image
[chat] Injecting image from generate_and_review tool
[chat] Injected image message saved to chat history
```

If second iteration fails, look for:
```
[chat] generate_and_review completed but no pending image found
```

This would indicate the tool isn't returning the image in `details.pendingImage` on subsequent iterations.

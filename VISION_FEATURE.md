# Vision Analysis Feature Implementation

## Overview

Ported vision-bot functionality into quje agent's Image Sandbox, enabling users to:
1. Upload images via drag-and-drop or file browser
2. Get AI-generated descriptions using multiple preset templates
3. Chat about images with follow-up questions and refinements
4. Re-analyze images with different description styles
5. Maintain a gallery of analyzed images with saved conversations

## Architecture

### Server-Side (`server/src/`)

#### New Services
- **`services/vision-analysis.ts`**: Core vision analysis logic
  - `VLM_PRESETS`: 7 description templates (Simple, Detailed, Tags, Cinematic, Style Focus, Z-Image, Stable Diffusion)
  - `analyzeImage()`: Sends image to Qwen3-VL via Ollama with preset prompt
  - `chatAboutImage()`: Multi-turn conversation about an image
  - `saveAnalyzedImage()`, `getAnalyzedImages()`, etc.: Persistence layer
  - Model slot management (waits for GPU availability)

#### New Routes
- **`routes/vision.ts`**: REST API endpoints
  - `GET /api/vision/presets` - List available description presets
  - `GET /api/vision/images` - List all analyzed images
  - `GET /api/vision/images/:id` - Get single image with conversation
  - `POST /api/vision/analyze` - Analyze and save new image
  - `POST /api/vision/images/:id/chat` - Chat about an image
  - `POST /api/vision/images/:id/reanalyze` - Re-analyze with different preset
  - `DELETE /api/vision/images/:id` - Delete an analyzed image
  - `GET /api/vision/images/:id/:filename` - Serve image files

#### Data Storage
- Location: `~/.quje-agent/vision/`
- Structure:
  ```
  vision/
  └── images/
      ├── <uuid>/
      │   ├── image-<timestamp>.png
      │   └── metadata.json
      └── ...
  ```
- `metadata.json` contains: id, filename, url, description, preset, conversation[], createdAt, imageData (base64)

### Client-Side (`client/src/`)

#### New Hooks
- **`hooks/useVisionSandbox.ts`**: State management for vision analysis
  - Loads presets and analyzed images on mount
  - Handles analyze, chat, re-analyze, delete operations
  - Maintains local state for selected image and conversations

#### New Components
- **`components/VisionControls.tsx`**: Upload interface
  - Drag-and-drop zone
  - File browser button
  - Preset selector dropdown
  - Analyzing state indicator

- **`components/VisionGallery.tsx`**: Grid view of analyzed images
  - Thumbnail grid with hover overlays
  - Selection indicator
  - Delete button
  - Empty state message

- **`components/VisionChat.tsx`**: Conversation interface
  - Shows initial description
  - Chat message history
  - Text input for follow-up questions
  - Re-analyze dropdown
  - Markdown rendering for responses

#### Modified Components
- **`components/ImageSandbox.tsx`**: Now supports two modes
  - **Generate mode**: Original ComfyUI image generation
  - **Analyze mode**: New vision analysis functionality
  - Mode switcher in header
  - Gallery/Chat view toggle for analyze mode

#### API Client Extensions
- **`api/client.ts`**: Added vision analysis functions
  - `fetchVisionPresets()`, `fetchAnalyzedImages()`, etc.
  - Type definitions for VisionPreset, VisionMessage, AnalyzedImage

## Usage

### For Users

1. **Open Image Sandbox**: Click the Image Sandbox button in the sidebar
2. **Switch to Analyze mode**: Click "Analyze" tab in header
3. **Upload an image**: Drag-and-drop or click to browse
4. **Select a preset**: Choose description style from dropdown
5. **View chat**: After analysis, automatically switches to chat view
6. **Ask follow-ups**: Type questions or refinement requests
7. **Re-analyze**: Use dropdown to try different description styles
8. **Browse gallery**: Switch to Gallery view to see all analyzed images

### For Developers

#### Environment Variables
- `VLM_MODEL_NAME`: Vision language model (default: `qwen3-vl:4b`)
- `OLLAMA_URL`: Ollama API endpoint (default: `http://localhost:11434`)

#### Prerequisites
```bash
ollama pull qwen3-vl:4b
```

#### API Examples

```typescript
// Analyze an image
const result = await analyzeImage(base64ImageData, "detailed");

// Chat about an image
const response = await chatAboutImage(imageId, "What's the lighting like?");

// Re-analyze with different style
const newResult = await reanalyzeImage(imageId, "sd");

// Delete an image
await deleteAnalyzedImage(imageId);
```

## Design Decisions

### Why server-side image storage?
- Keeps conversation context (imageData) available for multi-turn chat
- Avoids re-uploading images for each chat message
- Enables persistent gallery across sessions

### Why separate modes (Generate vs Analyze)?
- Different workflows and UI requirements
- Generation is one-shot, analysis is conversational
- Keeps ComfyUI integration separate from Ollama VLM

### Why store base64 imageData in metadata?
- Simplifies chat implementation (single fetch gets everything)
- Trade-off: larger metadata files, but conversations are typically short
- Alternative would be separate image file + metadata, requiring two fetches

### Model slot management
- Shares Ollama server with other workloads (chat, embeddings)
- Waits up to 5 minutes for GPU slot (matches vision-bot behavior)
- Skips check for cloud/remote models

## Future Enhancements

Potential improvements:
1. **Batch upload**: Analyze multiple images at once
2. **Export descriptions**: Download prompts for use in other tools
3. **Custom presets**: User-defined description templates
4. **Image comparison**: Side-by-side view of different analysis results
5. **Chat persistence**: Export/import conversations
6. **Search**: Find images by description content
7. **Tags**: Manual tagging for organization
8. **Integration**: Use analyzed descriptions as prompts for generation

## Testing

To test the implementation:

1. Start Ollama with vision model:
   ```bash
   ollama pull qwen3-vl:4b
   ollama serve
   ```

2. Start quje agent server:
   ```bash
   cd ~/quje-agent/server
   npm run dev
   ```

3. Start client:
   ```bash
   cd ~/quje-agent/client
   npm run dev
   ```

4. Open http://localhost:5173, navigate to Image Sandbox, switch to Analyze mode

## Comparison with vision-bot

| Feature | vision-bot | quje agent integration |
|---------|-----------|----------------------|
| Platform | Telegram bot | Web UI |
| Upload | Send image to bot | Drag-and-drop / file picker |
| Presets | 7 templates | Same 7 templates |
| Conversation | Reply to modify | Dedicated chat interface |
| State persistence | JSON file per user | SQLite-like structure |
| Multi-image | Per-user last image | Gallery of all images |
| Re-analyze | Inline buttons | Dropdown menu |
| Model management | Automatic slot waiting | Same implementation |

The quje agent implementation maintains feature parity with vision-bot while providing a richer UI and better organization through the gallery view.

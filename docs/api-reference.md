# API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/models` | List available Ollama models |
| GET | `/api/chats` | List all chats |
| POST | `/api/chats` | Create chat (`{ modelId, type: "agent"\|"quick", projectId? }`) |
| PATCH | `/api/chats/:id` | Update chat metadata |
| DELETE | `/api/chats/:id` | Delete a chat |
| GET | `/api/chats/:id` | Get single chat with messages |
| POST | `/api/chat` | Send message (SSE stream) |
| POST | `/api/chat/enqueue` | Queue message for later delivery |
| POST | `/api/chat/edit` | Edit and resend a message |
| GET | `/api/memory` | List memories (without embeddings) |
| POST | `/api/memory` | Create memory |
| POST | `/api/memory/search` | Semantic search (`{ query, topK? }`) |
| GET | `/api/memory/status` | Embedding model status + memory count + extraction metrics |
| GET | `/api/memory/synthesis/status` | Last synthesis timestamp + memory count |
| POST | `/api/memory/synthesis/run` | Manually trigger synthesis |
| POST | `/api/memory/conversations/search` | Conversation search (`{ query, chatId?, limit? }`) — FTS5 on chat history |
| GET | `/api/projects` | List all projects |
| POST | `/api/projects` | Create project (`{ name, path }`) |
| PATCH | `/api/projects/:id` | Update project |
| DELETE | `/api/projects/:id` | Delete project (orphans chats) |
| GET | `/api/projects/:id/agents-md` | Get project's AGENTS.md content |
| GET | `/api/tts` | Get TTS settings |
| PUT | `/api/tts` | Update TTS settings |
| GET | `/api/tts/voices` | List available voices |
| GET | `/api/vision` | List analyzed images |
| POST | `/api/vision/analyze` | Analyze an image |
| POST | `/api/vision/save` | Save analyzed image |
| POST | `/api/vision/images/:id/chat` | Chat about analyzed image |
| GET | `/api/images` | List generated images |
| POST | `/api/images/generate` | Generate image via ComfyUI |
| DELETE | `/api/images/:id` | Delete generated image |
| GET | `/api/images/status` | ComfyUI status |
| GET | `/api/user-images` | List uploaded images |
| POST | `/api/user-images` | Upload image |
| DELETE | `/api/user-images/:id` | Delete uploaded image |
| GET | `/api/artifacts/:id` | Serve artifact HTML |
| GET | `/api/artifacts/:id/*` | Serve artifact assets |
| GET | `/api/skills` | List available skills |
| GET | `/api/persona` | Get current persona |
| GET | `/api/corpus/clusters` | Get all clusters |
| GET | `/api/corpus/clusters/:id` | Get single cluster with members |
| POST | `/api/corpus/rebuild-clusters` | Rebuild clusters from current corpus |
| GET | `/api/corpus/visualization` | Get D3 force-directed graph HTML |
| GET | `/api/corpus/stats` | Get corpus statistics (auth required) |
| GET | `/api/corpus/stats-public` | Get corpus statistics (public) |
| GET | `/api/corpus/directions` | Get creative directions (with caching) |
| POST | `/api/corpus/directions/generate` | Queue direction generation job |
| GET | `/api/corpus/directions/job/:id` | Get job status |
| GET | `/api/corpus/gaps` | Analyze underrepresented themes |
| POST | `/api/corpus/remix` | Generate remix from specific clusters |
| POST | `/api/corpus/execute` | Execute creative direction (generate image) |
| GET | `/api/corpus/cache` | Get cache metadata (debugging) |
| POST | `/api/corpus/cache/clear` | Clear direction cache |
| POST | `/api/auth/register` | Register passkey |
| POST | `/api/auth/login` | Login with passkey |
| POST | `/api/auth/logout` | Logout |
| POST | `/api/bluesky/login` | Login to Bluesky and create dedicated chat |
| POST | `/api/bluesky/logout` | Logout from Bluesky |
| GET | `/api/notebooks/user` | List user notebook entries |
| GET | `/api/notebooks/agent` | List agent notebook entries |
| GET | `/api/notebooks/:id` | Get single notebook entry |
| POST | `/api/notebooks` | Create notebook entry |
| PATCH | `/api/notebooks/:id` | Update notebook entry |
| DELETE | `/api/notebooks/:id` | Delete notebook entry |
| GET | `/api/image-corpus/` | List all corpus entries |
| GET | `/api/image-corpus/stats` | Corpus statistics |
| GET | `/api/image-corpus/:id` | Get single corpus entry |
| POST | `/api/image-corpus/search` | Semantic corpus search |
| GET | `/api/image-corpus/by-chat/:chatId` | Corpus entries by chat |
| GET | `/api/image-corpus/by-project/:projectId` | Corpus entries by project |
| POST | `/api/image-corpus/enrich` | Batch corpus enrichment |
| GET | `/api/ui-state/` | Get persisted UI state |
| PUT | `/api/ui-state/` | Save UI state |
| GET | `/api/user/` | Get user profile document |
| PUT | `/api/user/` | Save user profile document |
| DELETE | `/api/user/` | Delete user profile document |
| GET | `/api/visuals/:id` | Serve visual HTML by ID |

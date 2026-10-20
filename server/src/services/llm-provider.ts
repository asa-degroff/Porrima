import { createModels, createProvider } from "@earendil-works/pi-ai";
import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamOpenAICompat } from "./openai-compat-provider.js";

// All inference runs against local servers through one OpenAI-compatible
// provider path: llama.cpp (the default) and Strata
// (docs/design/strata-backend.md). The provider is built
// on pi-ai's Models collection instead of the deprecated /compat registry
// (registerApiProvider + global streamSimple), which pi-ai will delete in the
// ModelManager migration. Dispatch resolves the owning provider by
// model.provider, so the persisted "openai-compat" api label on stored
// messages remains an inert identity field. Both providers share
// streamOpenAICompat, which branches on model.provider for backend-specific
// request policy.
//
// Model discovery stays in models.ts (its own TTL cache and stale fallback);
// the collection is only the dispatch surface, so the provider list is empty.
const llamacppProvider = createProvider({
  id: "llamacpp",
  name: "llama.cpp",
  auth: {
    apiKey: {
      name: "llama.cpp",
      // Keyless local server — always configured.
      resolve: async () => ({ auth: {} }),
    },
  },
  models: [],
  api: {
    stream: streamOpenAICompat,
    streamSimple: streamOpenAICompat,
  },
});

const strataProvider = createProvider({
  id: "strata",
  name: "Strata",
  auth: {
    apiKey: {
      name: "Strata",
      // Optional API key lives in settings (strataApiKey) and is attached by
      // the provider itself; dispatch needs no resolved secret.
      resolve: async () => ({ auth: {} }),
    },
  },
  models: [],
  api: {
    stream: streamOpenAICompat,
    streamSimple: streamOpenAICompat,
  },
});

const llamaModels = createModels();
llamaModels.setProvider(llamacppProvider);
llamaModels.setProvider(strataProvider);

/**
 * Stream a completion from the local inference provider (llama.cpp or
 * Strata, resolved by `model.provider`). Options pass through to
 * the provider unchanged (llama.cpp-specific extensions like llamaSlotLease
 * and onModelProgress ride along via the Models option spread).
 *
 * `context` may be a raw `{systemPrompt, messages, tools}` shape (one-shot
 * utility calls) or a normalized transcript (the agent loop). `Models`
 * normalizes the former before dispatch, and `normalizeContext` is idempotent
 * for the latter.
 */
export function streamLlamaCpp(
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions & Record<string, unknown>,
): AssistantMessageEventStream {
  return llamaModels.streamSimple(model, context, options);
}

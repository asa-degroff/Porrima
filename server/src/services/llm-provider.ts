import { createModels, createProvider } from "@earendil-works/pi-ai";
import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamOpenAICompat } from "./openai-compat-provider.js";

// All inference runs against local llama.cpp servers. The provider is built
// on pi-ai's Models collection instead of the deprecated /compat registry
// (registerApiProvider + global streamSimple), which pi-ai will delete in the
// ModelManager migration. Dispatch resolves the owning provider by
// model.provider, so the persisted "openai-compat" api label on stored
// messages remains an inert identity field.
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

const llamaModels = createModels();
llamaModels.setProvider(llamacppProvider);

/**
 * Stream a completion from the llama.cpp provider. Options pass through to
 * the provider unchanged (llama.cpp-specific extensions like llamaSlotLease
 * and onModelProgress ride along via the Models option spread).
 */
export function streamLlamaCpp(
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions & Record<string, unknown>,
): AssistantMessageEventStream {
  return llamaModels.streamSimple(model, context, options);
}

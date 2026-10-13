export { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
export { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy"
export { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"
import { lazyApi } from "@earendil-works/pi-ai/api/lazy"

export const googleGenerativeAIApi = () =>
  lazyApi(() => import("./google.ts").then(({ stream, streamSimple }) => ({ stream, streamSimple })))

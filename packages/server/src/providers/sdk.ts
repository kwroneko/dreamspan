export { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy"
export { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"
import { lazyApi } from "@earendil-works/pi-ai/api/lazy"
import { openAICompletionsApi as piOpenAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import { resolveSamplingParams } from "@earendil-works/pi-ai/api/simple-options"

export const openAICompletionsApi: typeof piOpenAICompletionsApi = () => {
  const api = piOpenAICompletionsApi()
  return {
    ...api,
    streamSimple(model, context, options) {
      if (!model.reasoning || options?.reasoning !== undefined) return api.streamSimple(model, context, options)
      // The capability flag also controls transcript roles and reasoning replay. Leave it on
      // and drop the SDK's generated Off fields before the app applies payload overrides.
      const sampling = resolveSamplingParams(model, "off", options?.samplingParams) ?? {}
      return api.streamSimple(model, context, {
        ...options,
        onPayload(payload, sentModel) {
          const body = payload as Record<string, unknown>
          for (const field of [
            "reasoning_effort",
            "reasoning",
            "thinking",
            "enable_thinking",
            "chat_template_kwargs",
            "chat_template_args"
          ]) {
            if (!Object.hasOwn(sampling, field)) delete body[field]
          }
          return options?.onPayload?.(body, sentModel)
        }
      })
    }
  }
}

export const googleGenerativeAIApi = () =>
  lazyApi(() => import("./google.ts").then(({ stream, streamSimple }) => ({ stream, streamSimple })))

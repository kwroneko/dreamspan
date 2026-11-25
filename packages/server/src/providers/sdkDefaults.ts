// SDK features follow the wire, with only the operation/model refusals recorded in TOOL-LOADING §17.
import { isOpenRouterEndpoint } from "@dreamspan/shared/providerDefinitions.ts"

interface Target {
  readonly api: string
  readonly provider: string
  readonly baseUrl: string
  readonly key: string
  readonly hasEffort: boolean
  readonly hasPriorEffort: boolean
}

export const sdkCapabilityDefaults = (target: Target): Record<string, boolean> => {
  const { api, provider, baseUrl, key, hasEffort, hasPriorEffort } = target
  const responses = api === "openai-responses"
  const messages = api === "anthropic-messages"
  const router = provider === "openrouter" || isOpenRouterEndpoint(baseUrl)
  const mini = /(?:^|[./:])gpt-5\.4-mini(?:$|[-@:])/i.test(key)
  const nano = /(?:^|[./:])gpt-5\.4-nano(?:$|[-@:])/i.test(key)
  const sonnet46 = /(?:^|[./:])claude-sonnet-4[.-]6(?:$|[-@:])/i.test(key)
  return {
    ...(responses
      ? {
          supportsExplicitPromptCacheMode: !router && !mini,
          supportsAdditionalTools: !(router && mini),
          supportsToolSearch: !nano && !(router && mini),
          supportsMidConvoSystemMessages: true
        }
      : {}),
    ...(messages
      ? {
          supportsMidConvoSystemMessages: !sonnet46,
          supportsMidConvoToolChanges: !sonnet46,
          ...(hasEffort && hasPriorEffort ? { supportsMidConvoEffort: !sonnet46 } : {})
        }
      : {})
  }
}

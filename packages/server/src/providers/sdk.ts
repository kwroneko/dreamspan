// The audited bundle has no ambient SDK configuration and requires our Google transport.
// Server builds, development startup and test setup rebuild the pinned dependencies.
const sdk = (await import(
  new URL("../../dist/providers/sdkEntry.mjs", import.meta.url).href
)) as typeof import("./sdkEntry.ts")
export const { openAICompletionsApi, openAIResponsesApi, anthropicMessagesApi, googleGenerativeAIApi } = sdk

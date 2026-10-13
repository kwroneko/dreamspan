import { serverEnvironment } from "./serverEnvironment.ts"

// Startup-only: this module must not import providers, SDKs or server configuration.
// Audited against pi-ai 1.0.3, openai 7.19.0, anthropic 0.129.0, genai 2.21.0.
const prefixes = [
  "OPENAI_",
  "ANTHROPIC_",
  "AZURE_OPENAI_",
  "AWS_",
  "GOOGLE_",
  "GEMINI_",
  "GCLOUD_",
  "CLOUDSDK_",
  "PI_",
  "ANT_LING_",
  "QWEN_",
  "NVIDIA_",
  "DEEPSEEK_",
  "GROQ_",
  "CEREBRAS_",
  "XAI_",
  "TYPESAFE_",
  "RADIUS_",
  "OPENROUTER_",
  "AI_GATEWAY_",
  "ZAI_",
  "MISTRAL_",
  "MINIMAX_",
  "MOONSHOT_",
  "HF_",
  "FIREWORKS_",
  "TOGETHER_",
  "BASETEN_",
  "OPENCODE_",
  "KIMI_",
  "META_",
  "CLOUDFLARE_",
  "XIAOMI_",
  "COPILOT_"
]
const names = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"])
const matches = (name: string) => {
  const upper = name.toUpperCase()
  return names.has(upper) || prefixes.some((prefix) => upper.startsWith(prefix))
}

export const scrubProviderEnvironment = (
  env: NodeJS.ProcessEnv = process.env,
  protectedVariables: ReadonlyArray<string> = Object.values(serverEnvironment)
) => {
  // Validate the entire configuration before deleting anything, even unset variables.
  for (const name of protectedVariables)
    if (matches(name)) throw new Error(`Provider environment scrub overlaps server configuration: ${name}`)
  for (const name of Object.keys(env)) if (matches(name)) delete env[name]
}

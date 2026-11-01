// The APIs SillyTavern records on a message it generated (`extra.api`: `getGeneratingApi` in
// ST's public/script.js, the chat completion source or the text completion type), by the
// names people know them by. An imported version's model is shown as "API · model" with them
// (Version.model), since ST's models aren't the user's connections here.

const LABELS: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  azure_openai: "Azure OpenAI",
  claude: "Anthropic",
  openrouter: "OpenRouter",
  makersuite: "Google AI Studio",
  vertexai: "Google Vertex AI",
  mistralai: "Mistral AI",
  deepseek: "DeepSeek",
  xai: "xAI",
  cohere: "Cohere",
  groq: "Groq",
  perplexity: "Perplexity",
  ai21: "AI21",
  moonshot: "Moonshot AI",
  zai: "Z.AI",
  fireworks: "Fireworks AI",
  siliconflow: "SiliconFlow",
  nanogpt: "NanoGPT",
  chutes: "Chutes",
  electronhub: "Electron Hub",
  pollinations: "Pollinations",
  cometapi: "CometAPI",
  aimlapi: "AI/ML API",
  custom: "Custom",
  textgenerationwebui: "Text Generation WebUI",
  ooba: "Text Generation WebUI",
  koboldcpp: "KoboldCpp",
  kobold: "KoboldAI",
  koboldhorde: "AI Horde",
  novel: "NovelAI",
  llamacpp: "llama.cpp",
  ollama: "Ollama",
  vllm: "vLLM",
  aphrodite: "Aphrodite",
  tabby: "TabbyAPI",
  togetherai: "Together AI",
  infermaticai: "InfermaticAI",
  dreamgen: "DreamGen",
  mancer: "Mancer",
  featherless: "Featherless",
  huggingface: "Hugging Face",
  generic: "Generic API"
}

/** An ST API id as people know it; an id this list doesn't have, as written. */
export const stApiLabel = (api: string) => LABELS[api] ?? api

/** "OpenRouter · anthropic/claude-3.5-sonnet", or whichever half ST recorded; null for neither. */
export const recordedModelLabel = (api: string | undefined, model: string | undefined) => {
  const parts = [api ? stApiLabel(api) : "", model ?? ""].filter((part) => part !== "")
  return parts.length === 0 ? null : parts.join(" · ")
}

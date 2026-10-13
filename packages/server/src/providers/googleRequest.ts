// The supported SDK parameter surface, translated to Gemini Developer REST.
// Audited against genai 2.21.0 generateContentParametersToMldev and tContent.
// Unknown options fail here instead of accidentally becoming generationConfig fields.
import { Predicate } from "effect"

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (!Predicate.isObject(value) || Array.isArray(value)) throw new Error(`Google ${name} must be an object`)
  return value as Record<string, unknown>
}
const fields = (value: unknown, allowed: string[], name: string) => {
  const source = record(value, name)
  for (const key of Object.keys(source))
    if (source[key] !== undefined && !allowed.includes(key)) throw new Error(`Unsupported Google ${name}.${key}`)
  return Object.fromEntries(Object.entries(source).filter(([, v]) => v != null))
}
const list = (value: unknown, name: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`Google ${name} must be an array`)
  return value
}
const part = (value: unknown): Record<string, unknown> => {
  if (typeof value === "string") return { text: value }
  const p = fields(
    value,
    [
      "text",
      "thought",
      "thoughtSignature",
      "inlineData",
      "fileData",
      "functionCall",
      "functionResponse",
      "executableCode",
      "codeExecutionResult",
      "videoMetadata",
      "mediaResolution"
    ],
    "part"
  )
  if (p.inlineData != null) p.inlineData = fields(p.inlineData, ["data", "mimeType"], "inlineData")
  if (p.fileData != null) p.fileData = fields(p.fileData, ["fileUri", "mimeType"], "fileData")
  if (p.functionCall != null) p.functionCall = fields(p.functionCall, ["id", "name", "args"], "functionCall")
  return p
}
const content = (value: unknown) => {
  if (Predicate.isObject(value) && Array.isArray(value.parts)) {
    const c = fields(value, ["parts", "role"], "content")
    return { ...c, parts: value.parts.map(part) }
  }
  return { role: "user", parts: (Array.isArray(value) ? value : [value]).map(part) }
}
const contents = (value: unknown) => {
  if (!Array.isArray(value)) return [content(value)]
  if (!value.length) throw new Error("Google contents are required")
  const structured = (v: unknown) => Predicate.isObject(v) && Array.isArray(v.parts)
  if (value.every(structured)) return value.map(content)
  if (value.some(structured)) throw new Error("Google contents cannot mix Content and Parts")
  return [content(value)]
}
const tool = (value: unknown) => {
  const t = fields(value, ["functionDeclarations", "codeExecution", "urlContext", "googleSearchRetrieval"], "tool")
  if (t.functionDeclarations != null)
    t.functionDeclarations = list(t.functionDeclarations, "functionDeclarations").map((d) =>
      // Use full JSON Schema, as pi-ai does. The legacy parameters/response schema
      // dialect needs further SDK conversion and is deliberately not accepted here.
      fields(
        d,
        ["name", "description", "parametersJsonSchema", "responseJsonSchema", "behavior"],
        "functionDeclaration"
      )
    )
  return t
}
const generationFields = [
  "temperature",
  "topP",
  "topK",
  "candidateCount",
  "maxOutputTokens",
  "stopSequences",
  "responseLogprobs",
  "logprobs",
  "presencePenalty",
  "frequencyPenalty",
  "seed",
  "responseMimeType",
  "responseJsonSchema",
  "responseModalities",
  "mediaResolution",
  "speechConfig",
  "thinkingConfig",
  "audioTranscriptionConfig",
  "imageConfig",
  "enableEnhancedCivicAnswers"
]

export const googleRequest = (payload: unknown) => {
  const p = fields(payload, ["model", "contents", "config"], "parameters")
  if (typeof p.model !== "string" || !/^(?:(?:models|tunedModels)\/)?[\w.-]+$/.test(p.model) || p.model.includes(".."))
    throw new Error("Invalid Google model resource name")
  const model = p.model.includes("/") ? p.model : `models/${p.model}`
  const config = fields(
    p.config ?? {},
    [
      ...generationFields,
      "serviceTier",
      "systemInstruction",
      "tools",
      "toolConfig",
      "safetySettings",
      "cachedContent",
      "httpOptions",
      "abortSignal"
    ],
    "config"
  )
  if (config.httpOptions != null) fields(config.httpOptions, [], "httpOptions")
  const generationConfig = Object.fromEntries(Object.entries(config).filter(([key]) => generationFields.includes(key)))
  if (generationConfig.imageConfig != null)
    generationConfig.imageConfig = fields(generationConfig.imageConfig, ["aspectRatio", "imageSize"], "imageConfig")
  if (typeof generationConfig.speechConfig === "string")
    generationConfig.speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: generationConfig.speechConfig } }
    }
  const body: Record<string, unknown> = { contents: contents(p.contents), generationConfig }
  if (config.serviceTier != null) body.serviceTier = config.serviceTier
  if (config.systemInstruction != null) body.systemInstruction = content(config.systemInstruction)
  if (config.tools != null) body.tools = list(config.tools, "tools").map(tool)
  if (config.toolConfig != null) {
    const tc = fields(
      config.toolConfig,
      ["functionCallingConfig", "retrievalConfig", "includeServerSideToolInvocations"],
      "toolConfig"
    )
    if (tc.functionCallingConfig != null)
      tc.functionCallingConfig = fields(
        tc.functionCallingConfig,
        ["mode", "allowedFunctionNames"],
        "functionCallingConfig"
      )
    body.toolConfig = tc
  }
  if (config.safetySettings != null)
    body.safetySettings = list(config.safetySettings, "safetySettings").map((s) =>
      fields(s, ["category", "threshold"], "safetySetting")
    )
  if (config.cachedContent != null) {
    if (typeof config.cachedContent !== "string") throw new Error("Google cachedContent must be a string")
    body.cachedContent = config.cachedContent.includes("/")
      ? config.cachedContent
      : `cachedContents/${config.cachedContent}`
  }
  // Routing, headers, retries and cancellation remain owned by the request's
  // controlled transport. SDK httpOptions/abortSignal never enter the REST body.
  return { model, body }
}

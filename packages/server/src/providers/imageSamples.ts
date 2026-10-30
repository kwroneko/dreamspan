// Ledger calibration for image tokens (ARCHITECTURE §6): what a finished request's images
// cost together, for models without a published formula. Read from the final wire payload, so
// it's the images actually sent, in every wire API's shape.
import { estimateTokens } from "../assembler/st.ts"
import { describeImage } from "../importer/images.ts"

const base64Of = (node: Record<string, unknown>): string | null => {
  const url =
    node["type"] === "image_url"
      ? (node["image_url"] as { url?: unknown } | undefined)?.url
      : node["type"] === "input_image"
        ? node["image_url"]
        : undefined
  if (typeof url === "string") return /^data:[^;,]+;base64,(.*)$/s.exec(url)?.[1] ?? null
  if (node["type"] === "image") {
    const source = node["source"] as { type?: unknown; data?: unknown } | undefined
    return source?.type === "base64" && typeof source.data === "string" ? source.data : null
  }
  const inline = (node["inlineData"] ?? node["inline_data"]) as { data?: unknown } | undefined
  return typeof inline?.data === "string" ? inline.data : null
}

const TEXT_KEYS = new Set(["text", "content", "system", "instructions"])
const MESSAGE_LISTS = new Set(["messages", "contents", "input"])

/** The sent images (count, total pixels) and the text estimate of the same payload, as assembly counts text. */
export const payloadImages = (payload: unknown) => {
  let images = 0
  let pixels = 0
  let sized = true
  let text = 0
  const visit = (node: unknown, key: string | null) => {
    if (typeof node === "string") {
      if (key !== null && TEXT_KEYS.has(key)) text += estimateTokens(node)
      return
    }
    if (Array.isArray(node)) {
      if (key !== null && MESSAGE_LISTS.has(key)) text += 3 * node.length
      for (const item of node) visit(item, null)
      return
    }
    if (!node || typeof node !== "object") return
    const data = base64Of(node as Record<string, unknown>)
    if (data !== null) {
      images++
      const { width, height } = describeImage(Buffer.from(data, "base64"))
      if (width && height) pixels += width * height
      else sized = false
      return
    }
    for (const [k, v] of Object.entries(node)) visit(v, k)
  }
  visit(payload, null)
  return { images, pixels: sized ? pixels : null, text }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** Image tokens a provider reports itself: xAI's `image_tokens`, Gemini's IMAGE modality. */
export const reportedImageTokens = (raw: Record<string, unknown> | null): number | null => {
  if (!raw) return null
  const details = record(raw["prompt_tokens_details"]) ?? record(raw["input_tokens_details"])
  const tokens = details?.["image_tokens"]
  if (typeof tokens === "number") return tokens
  const modalities = raw["promptTokensDetails"] ?? raw["prompt_tokens_details"]
  if (Array.isArray(modalities)) {
    const image = modalities.map(record).find((m) => m?.["modality"] === "IMAGE")
    if (typeof image?.["tokenCount"] === "number") return image["tokenCount"]
  }
  return null
}

/** The sample to record, or null: per-request image tokens, reported or derived from the input count. */
export const imageSample = (
  sent: ReturnType<typeof payloadImages>,
  input: number | null,
  raw: Record<string, unknown> | null
) => {
  if (sent.images === 0 || sent.pixels === null) return null
  const reported = reportedImageTokens(raw)
  if (reported !== null && (!Number.isSafeInteger(reported) || reported <= 0)) return null
  if (reported !== null)
    return { images: sent.images, pixels: sent.pixels, tokens: reported, source: "reported" as const }
  if (input === null) return null
  const derived = input - sent.text
  return derived > 0 ? { images: sent.images, pixels: sent.pixels, tokens: derived, source: "derived" as const } : null
}

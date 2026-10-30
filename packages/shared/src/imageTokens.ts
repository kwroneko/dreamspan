// What an image costs in the prompt, per provider (DESIGN §10.2a; ARCHITECTURE §6, §15).
// Pure formulas from each provider's documentation, as read on 2026-10-30, and the rules
// that pick one by provider kind and model. The assembler registers the rules through its
// `imageTokens` registry, so a plugin can add, replace or disable one.

/** Where an image's token figure comes from. */
type ImageTokenBasis = "counted" | "formula" | "calibrated" | "unknown"

/** One image's estimate, as assembly records it on the request message. */
export interface ImageEstimate {
  /** Null when nothing says what it costs: shown as unknown, never as zero. */
  readonly tokens: number | null
  readonly basis: ImageTokenBasis
  /** The detail level the image is sent with, where the provider has one. */
  readonly detail?: string
  /** A documented upper bound, budgeted for while the exact figure is unknown. */
  readonly bound?: number
  readonly note?: string
  /** False when a rule leaves the image out of the request (the last-N limit). */
  readonly sent?: false
}

/** What the budget counts for an image whose cost nothing states. */
const UNKNOWN_IMAGE_RESERVE = 1024

/** The tokens the budget counts for an image: its figure, else its bound, else the reserve. */
export const budgetTokens = (estimate: ImageEstimate | undefined) =>
  estimate?.sent === false ? 0 : (estimate?.tokens ?? estimate?.bound ?? UNKNOWN_IMAGE_RESERVE)

/** The request an image goes to: provider kind, wire API and the model as the connection names it. */
export interface ImageTarget {
  readonly kind: string
  readonly api: string
  readonly model: string
}

export interface ImageSize {
  readonly width: number
  readonly height: number
}

/** A rule's figure for one image; `tokens: null` with a `bound` says only how much it can be. */
export type RuleEstimate =
  | { readonly tokens: number; readonly detail?: string; readonly note?: string }
  | { readonly tokens: null; readonly bound: number; readonly note: string }

/**
 * Image token rules are tried newest registration first; the first that applies and returns
 * a figure wins. Returning null passes to the next.
 */
export interface ImageTokenRule {
  readonly id: string
  readonly appliesTo: (target: ImageTarget) => boolean
  readonly estimate: (image: ImageSize, target: ImageTarget) => RuleEstimate | null
}

/** A router's model id names its upstream as `vendor/model`; the family is the model part. */
const upstreamModel = (model: string) => {
  const slash = model.lastIndexOf("/")
  return (slash < 0 ? model : model.slice(slash + 1)).toLowerCase()
}

// --- Anthropic: 28-pixel patches, after resizing to the model tier's limits.
// https://platform.claude.com/docs/en/build-with-claude/vision (Resolution and token cost)
// https://platform.claude.com/docs/en/build-with-claude/vision-coordinates (reference implementation)

/** Python's round(): exact halves go to the even neighbour, as the API does. */
const roundTiesToEven = (value: number) => {
  const floor = Math.floor(value)
  if (value - floor !== 0.5) return Math.round(value)
  return floor % 2 === 0 ? floor : floor + 1
}

const anthropicPatches = (width: number, height: number) => Math.ceil(width / 28) * Math.ceil(height / 28)

/** The size Anthropic resizes an image to, ported from its reference implementation. */
export const anthropicResize = (
  width: number,
  height: number,
  maxEdge: number,
  maxTokens: number
): readonly [number, number] => {
  const fits = (w: number, h: number) =>
    Math.ceil(w / 28) * 28 <= maxEdge && Math.ceil(h / 28) * 28 <= maxEdge && anthropicPatches(w, h) <= maxTokens
  if (fits(width, height)) return [width, height]
  if (height > width) {
    const [h, w] = anthropicResize(height, width, maxEdge, maxTokens)
    return [w, h]
  }
  // The reference's float division and ties-to-even rounding, kept exactly.
  const aspectRatio = width / height
  let lo = 1
  let hi = width
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (fits(mid, Math.max(roundTiesToEven(mid / aspectRatio), 1))) lo = mid
    else hi = mid
  }
  return [lo, Math.max(roundTiesToEven(lo / aspectRatio), 1)]
}

/** Claude 4.7 and later are on the high-resolution tier; a name without a version is assumed new. */
export const anthropicTier = (model: string) => {
  const name = upstreamModel(model)
  const pair = /(\d+)[-.](\d{1,2})(?!\d)/.exec(name)
  const major = pair ? Number(pair[1]) : Number(/(\d+)/.exec(name)?.[1] ?? NaN)
  if (Number.isNaN(major)) return { maxEdge: 2576, maxTokens: 4784, tier: "high" as const }
  const minor = pair ? Number(pair[2]) : 0
  return major > 4 || (major === 4 && minor >= 7)
    ? { maxEdge: 2576, maxTokens: 4784, tier: "high" as const }
    : { maxEdge: 1568, maxTokens: 1568, tier: "standard" as const }
}

export const anthropicImageTokens = (image: ImageSize, model: string) => {
  const { maxEdge, maxTokens } = anthropicTier(model)
  const [w, h] = anthropicResize(image.width, image.height, maxEdge, maxTokens)
  return anthropicPatches(w, h)
}

// --- OpenAI: tiles or patches by model, at the detail level sent.
// https://developers.openai.com/api/docs/guides/images-vision (Calculating costs)

/** Tile models: base tokens plus tokens per 512-pixel tile. */
const openAITileTokens = (image: ImageSize, costs: { base: number; tile: number }, detail: string) => {
  if (detail === "low") return costs.base
  let { width, height } = image
  const fit = Math.min(1, 2048 / Math.max(width, height))
  width = Math.max(1, Math.floor(width * fit))
  height = Math.max(1, Math.floor(height * fit))
  const shortest = Math.min(width, height)
  if (shortest > 768) {
    const scale = 768 / shortest
    width = width === shortest ? 768 : Math.floor(width * scale)
    height = height === shortest ? 768 : Math.floor(height * scale)
  }
  return costs.base + Math.ceil(width / 512) * Math.ceil(height / 512) * costs.tile
}

/** A detail level's sizing for patch models: the longest side allowed, and the patch budget. */
interface PatchSizing {
  readonly maxDimension: number
  readonly budget: number | null
}

/** Patch models: 32-pixel patches after fitting and the patch budget, times the model's multiplier. */
export const openAIPatchTokens = (image: ImageSize, sizing: PatchSizing, multiplier: number) => {
  let { width, height } = image
  const fit = Math.min(1, sizing.maxDimension / Math.max(width, height))
  width = Math.max(1, Math.floor(width * fit))
  height = Math.max(1, Math.floor(height * fit))
  let patches = Math.ceil(width / 32) * Math.ceil(height / 32)
  if (sizing.budget !== null && patches > sizing.budget) {
    const shrink = Math.sqrt((32 ** 2 * sizing.budget) / (width * height))
    const adjusted =
      shrink *
      Math.min(
        Math.floor((width * shrink) / 32) / ((width * shrink) / 32),
        Math.floor((height * shrink) / 32) / ((height * shrink) / 32)
      )
    width = Math.max(1, Math.floor(width * adjusted))
    height = Math.max(1, Math.floor(height * adjusted))
    patches = Math.ceil(width / 32) * Math.ceil(height / 32)
  }
  return Math.ceil(patches * multiplier)
}

type Detail = "low" | "high" | "original" | "auto"
const LOW_512: PatchSizing = { maxDimension: 512, budget: null }
const HIGH_2500: PatchSizing = { maxDimension: 2048, budget: 2500 }
const WIDE_6144: PatchSizing = { maxDimension: 2048, budget: 6144 }
const ORIGINAL_10000: PatchSizing = { maxDimension: 6000, budget: 10000 }
const UNCAPPED: PatchSizing = { maxDimension: 65535, budget: null }

interface PatchModel {
  readonly multiplier: number
  readonly sizing: Readonly<Partial<Record<Detail, PatchSizing>>> & { readonly auto: PatchSizing }
  readonly note?: string
}

const patchModel = (model: string): PatchModel | null => {
  if (/^gpt-6-astra/.test(model))
    return {
      multiplier: 1.2,
      sizing: { low: LOW_512, high: { maxDimension: 65535, budget: 2500 }, original: UNCAPPED, auto: UNCAPPED }
    }
  if (/^gpt-5\.6/.test(model))
    return { multiplier: 1.2, sizing: { low: LOW_512, high: HIGH_2500, original: UNCAPPED, auto: UNCAPPED } }
  if (/^gpt-5\.5/.test(model))
    return {
      multiplier: 1.2,
      sizing: { low: LOW_512, high: HIGH_2500, original: ORIGINAL_10000, auto: ORIGINAL_10000 }
    }
  if (/^gpt-5\.4/.test(model))
    return {
      multiplier: 1.2,
      sizing: { low: WIDE_6144, high: HIGH_2500, original: ORIGINAL_10000, auto: HIGH_2500 }
    }
  const legacy = (multiplier: number, note?: string): PatchModel => ({
    multiplier,
    sizing: { low: WIDE_6144, high: WIDE_6144, auto: WIDE_6144 },
    ...(note ? { note } : {})
  })
  if (/^gpt-5\.2/.test(model)) return legacy(1.2)
  if (/^gpt-4\.1-mini/.test(model)) return legacy(1.62)
  return null
}

const tileModel = (model: string): { base: number; tile: number } | null => {
  if (/^(gpt-5-(mini|nano)|gpt-4\.1-nano)/.test(model)) return null
  if (/^gpt-4o-mini/.test(model)) return { base: 2833, tile: 5667 }
  if (/^(gpt-4o|chatgpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision)/.test(model)) return { base: 85, tile: 170 }
  if (/^gpt-5(\.1)?($|-)/.test(model)) return { base: 70, tile: 140 }
  if (/^(o1|o3)($|-)/.test(model)) return { base: 75, tile: 150 }
  return null
}

/** Our requests send `auto`: Responses says so (pi-ai), and Chat Completions omits it. */
export const openAIImageTokens = (image: ImageSize, model: string, detail: Detail = "auto"): RuleEstimate | null => {
  const name = upstreamModel(model)
  const patch = patchModel(name)
  if (patch) {
    const sizing = patch.sizing[detail] ?? patch.sizing.auto
    return {
      tokens: openAIPatchTokens(image, sizing, patch.multiplier),
      detail,
      ...(patch.note ? { note: patch.note } : {})
    }
  }
  const tile = tileModel(name)
  return tile ? { tokens: openAITileTokens(image, tile, detail), detail } : null
}

// --- Google Gemini.
// https://ai.google.dev/gemini-api/docs/tokens (Count multimodal tokens)
// https://ai.google.dev/gemini-api/docs/media-resolution (Gemini 3)

/** Before Gemini 3: 258 tokens up to 384×384, else 258 per 768×768 crop (Google's own rough rule). */
const geminiTileTokens = (image: ImageSize) => {
  if (image.width <= 384 && image.height <= 384) return 258
  const unit = Math.max(1, Math.floor(Math.min(image.width, image.height) / 1.5))
  return Math.ceil(image.width / unit) * Math.ceil(image.height / unit) * 258
}

/** Gemini 3 bills a fixed figure per media resolution; we send none, which is `high`'s 1120. */
const GEMINI_3_RESOLUTION = { low: 280, medium: 560, high: 1120, ultra_high: 2240 } as const

export const geminiImageTokens = (image: ImageSize, model: string): RuleEstimate | null => {
  const version = /gemini-(\d+)/.exec(upstreamModel(model))
  if (!version) return null
  const major = Number(version[1])
  return major >= 3
    ? { tokens: GEMINI_3_RESOLUTION.high, detail: "unspecified" }
    : { tokens: geminiTileTokens(image), note: "Google calls this formula approximate." }
}

// --- Mistral. https://docs.mistral.ai/studio/conversations/vision (FAQ)

export const mistralImageTokens = (image: ImageSize, model: string): RuleEstimate => {
  const pixtral = /pixtral/.test(upstreamModel(model))
  const side = pixtral ? 1024 : 1540
  const fit = Math.min(1, side / Math.max(image.width, image.height))
  const pixels = Math.floor(image.width * fit) * Math.floor(image.height * fit)
  return { tokens: Math.ceil(pixels / (pixtral ? 256 : 784)), note: "Mistral calls this formula approximate." }
}

// --- DeepSeek: no published formula, only its cap. https://api-docs.deepseek.com/guides/vision

/** Which family a model belongs to, from its name (a router's upstream included). */
const family = (target: ImageTarget) => {
  const model = target.model.toLowerCase()
  const name = upstreamModel(model)
  const vendor = model.includes("/") ? model.slice(0, model.indexOf("/")) : null
  if (target.kind === "anthropic" || vendor === "anthropic" || /^claude/.test(name)) return "anthropic"
  if (target.kind === "google" || vendor === "google" || /^gemini/.test(name)) return "google"
  if (vendor === "mistralai" || /^(mistral|pixtral|ministral|magistral)/.test(name)) return "mistral"
  if (target.kind === "deepseek" || vendor === "deepseek" || /^deepseek/.test(name)) return "deepseek"
  if (
    target.kind === "openai-responses" ||
    vendor === "openai" ||
    patchModel(name) !== null ||
    tileModel(name) !== null
  )
    return "openai"
  return null
}

/** The built-in rules, one per documented family. Routers reach them through the upstream's name. */
export const builtinImageTokenRules: ReadonlyArray<ImageTokenRule> = [
  {
    id: "anthropic",
    appliesTo: (target) => family(target) === "anthropic",
    estimate: (image, target) => ({ tokens: anthropicImageTokens(image, target.model) })
  },
  {
    id: "openai",
    appliesTo: (target) => family(target) === "openai",
    estimate: (image, target) => openAIImageTokens(image, target.model)
  },
  {
    id: "google",
    appliesTo: (target) => family(target) === "google",
    estimate: (image, target) => geminiImageTokens(image, target.model)
  },
  {
    id: "mistral",
    appliesTo: (target) => family(target) === "mistral",
    estimate: (image, target) => mistralImageTokens(image, target.model)
  },
  {
    id: "deepseek",
    appliesTo: (target) => family(target) === "deepseek",
    estimate: () => ({
      tokens: null,
      bound: 1024,
      note: "DeepSeek publishes only a cap of 1,024 tokens per image."
    })
  }
]

/** The first rule that applies and gives a figure, newest registration first. */
export const ruleEstimate = (rules: ReadonlyArray<ImageTokenRule>, image: ImageSize, target: ImageTarget) => {
  for (const rule of rules.toReversed()) {
    if (!rule.appliesTo(target)) continue
    const result = rule.estimate(image, target)
    if (result) return result
  }
  return null
}

/** A calibration sample from the ledger: a request's sent images and what they cost together. */
export interface CalibrationSample {
  readonly images: number
  readonly pixels: number
  readonly tokens: number
}

/**
 * Per-image cost from the ledger: tokens = a·images + b·pixels by least squares when the
 * samples' sizes differ (models whose cost grows with resolution), else the mean per image.
 */
export const calibratedTokens = (samples: ReadonlyArray<CalibrationSample>, image: ImageSize) => {
  const usable = samples.filter((s) => s.images > 0 && Number.isFinite(s.tokens) && s.tokens > 0)
  if (usable.length === 0) return null
  const perImage = usable.reduce((n, s) => n + s.tokens, 0) / usable.reduce((n, s) => n + s.images, 0)
  let [nn, np, pp, nt, pt] = [0, 0, 0, 0, 0]
  for (const s of usable) {
    nn += s.images * s.images
    np += s.images * s.pixels
    pp += s.pixels * s.pixels
    nt += s.images * s.tokens
    pt += s.pixels * s.tokens
  }
  const determinant = nn * pp - np * np
  // Only fit the size term when the samples' sizes differ enough to tell it from the constant.
  if (usable.length >= 2 && determinant > 1e-6 * nn * pp) {
    const a = (nt * pp - np * pt) / determinant
    const b = (nn * pt - np * nt) / determinant
    const fitted = a + b * image.width * image.height
    if (b >= 0 && fitted > 0) return Math.max(1, Math.round(fitted))
  }
  return Math.max(1, Math.round(perImage))
}

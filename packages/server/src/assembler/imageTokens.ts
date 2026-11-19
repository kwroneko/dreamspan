// The `image-tokens` stage (ARCHITECTURE §15): what each history image costs the model the
// context is built for, so the budget, the context view and the cache estimate count it.
// A provider's exact count wins; then the documented formula (registered rules); then the
// ledger's calibration; else the image is unknown, budgeted at a documented bound or a reserve.
import {
  budgetTokens,
  calibratedTokens,
  ruleEstimate,
  type ImageEstimate,
  type ImageTarget
} from "@dreamspan/shared/imageTokens.ts"
import { Effect } from "effect"
import { AssemblySources, need, type AssemblerStage, type ImageTokenFacts } from "./pipeline.ts"
import type { ContextImage } from "@dreamspan/shared/inspectorApi.ts"
import type { AssembledRequest, ModelInput, RequestImage, RequestMessage, WireContext } from "./types.ts"
import { newestImages } from "./images.ts"

/** The detail level our requests send (OpenAI's `auto`; others have none), which counts key on. */
const SENT_DETAIL = "auto"

const imageTarget = (model: Pick<ModelInput, "kind" | "api" | "key">): ImageTarget => ({
  kind: model.kind,
  api: model.api,
  model: model.key
})

const UNKNOWN_NOTE = "Unknown until the first request with an image reports what it cost."

/** One image's estimate from what's known; `sent: false` is added by the caller. */
export const estimateImage = (
  image: RequestImage,
  target: ImageTarget,
  rules: Parameters<typeof ruleEstimate>[0],
  facts: ImageTokenFacts
): ImageEstimate => {
  const counted = facts.counts.find((c) => c.sha256 === image.sha256 && c.detail === SENT_DETAIL)
  if (counted && counted.tokens > 0) return { tokens: counted.tokens, basis: "counted", detail: SENT_DETAIL }
  if (!image.width || !image.height) {
    const mean = calibratedTokens(
      facts.samples.map((sample) => ({ ...sample, pixels: 0 })),
      { width: 0, height: 0 }
    )
    return mean === null
      ? { tokens: null, basis: "unknown", note: "The image's size isn't recorded." }
      : { tokens: mean, basis: "calibrated" }
  }
  const size = { width: image.width, height: image.height }
  const rule = ruleEstimate(rules, size, target)
  if (rule && rule.tokens !== null && Number.isFinite(rule.tokens) && rule.tokens > 0)
    return {
      tokens: rule.tokens,
      basis: "formula",
      ...(rule.detail ? { detail: rule.detail } : {}),
      ...(rule.note ? { note: rule.note } : {})
    }
  const calibrated = calibratedTokens(facts.samples, size)
  if (calibrated !== null) return { tokens: calibrated, basis: "calibrated" }
  return rule?.tokens === null
    ? { tokens: null, basis: "unknown", bound: rule.bound, note: rule.note }
    : { tokens: null, basis: "unknown", note: UNKNOWN_NOTE }
}

const NO_FACTS: ImageTokenFacts = { counts: [], samples: [] }

/** Match dispatch's cap in final message order, including a moved Newest message marker. */
export const limitImageEstimates = <T extends { readonly images?: ReadonlyArray<RequestImage> }>(
  messages: ReadonlyArray<T>,
  max: number
): Array<T> => {
  const newest = newestImages(messages, max)
  return messages.map((message, m) => ({
    ...message,
    ...(message.images
      ? {
          images: message.images.map((image, i) => {
            const { sent: _, ...estimate } = image.estimate ?? { tokens: null, basis: "unknown" as const }
            return { ...image, estimate: newest.has(`${m}:${i}`) ? estimate : { ...estimate, sent: false as const } }
          })
        }
      : {})
  }))
}

/**
 * Estimates every image of the history read, newest first. Images past the model's last-N
 * limit are marked unsent, as dispatch leaves them out (`chat/messageImages.ts`): history is
 * cut from its oldest end, so the newest N read are the newest N sent.
 */
export const imageTokensStage: AssemblerStage = {
  id: "image-tokens",
  run: (assembly) =>
    Effect.gen(function* () {
      const resolved = need(assembly, "resolved")
      const model = assembly.model
      if (!model || !resolved.some(({ entry }) => entry.images?.length)) return assembly
      const target = imageTarget(model)
      const rules = assembly.request.imageTokens?.list() ?? []
      const sources = yield* AssemblySources
      const hashes = [
        ...new Set(resolved.flatMap(({ entry }) => (entry.images ?? []).flatMap((i) => (i.sha256 ? [i.sha256] : []))))
      ]
      const facts = sources.imageTokenFacts
        ? yield* sources.imageTokenFacts(
            { connectionId: model.connectionId, kind: model.kind, modelKey: model.key },
            hashes
          )
        : NO_FACTS
      let remaining = model.maxImages ?? 4
      const estimated = resolved.toReversed().map((item) => {
        if (!item.entry.images?.length) return item
        const images = item.entry.images.toReversed().map((image): RequestImage => {
          const estimate = estimateImage(image, target, rules, facts)
          // An image the fork took out of the context is never sent and takes no place in the limit.
          if ((image as { readonly excluded?: boolean }).excluded)
            return { ...image, estimate: { ...estimate, sent: false } }
          return { ...image, estimate: remaining-- > 0 ? estimate : { ...estimate, sent: false } }
        })
        return { ...item, entry: { ...item.entry, images: images.reverse() } }
      })
      assembly.resolved = estimated.reverse()
      return assembly
    })
}

/**
 * Each wire message's images: its own, else those of the request messages it came from.
 * Captured wire messages carry text only; an input feeding several wire messages counts once.
 */
export const wireImages = (
  messages: WireContext["messages"],
  request: Pick<AssembledRequest, "messages">
): Array<ReadonlyArray<RequestImage>> => {
  const seen = new Set<number>()
  return messages.map((message) => {
    if (message.images) return message.images
    return message.inputs.flatMap((i) => {
      if (seen.has(i)) return []
      seen.add(i)
      return (request.messages[i] as RequestMessage | undefined)?.images ?? []
    })
  })
}

/** Images of the request whose figure isn't a provider's count yet: what to count off the hot path. */
const uncountedImages = (request: Pick<AssembledRequest, "messages">) => {
  const seen = new Set<string>()
  return request.messages.flatMap((message) =>
    (message.images ?? []).flatMap((image) => {
      if (!image.sha256 || image.estimate?.basis === "counted" || image.estimate?.sent === false) return []
      if (seen.has(image.sha256)) return []
      seen.add(image.sha256)
      return [{ mediaId: image.mediaId, sha256: image.sha256 }]
    })
  )
}

/** An image's estimate as the context view shows it. */
export const contextImage = (image: RequestImage): ContextImage => {
  const estimate = image.estimate ?? { tokens: null, basis: "unknown" as const }
  return {
    tokens: estimate.tokens,
    basis: estimate.basis,
    budgeted: budgetTokens(estimate),
    ...(estimate.detail ? { detail: estimate.detail } : {}),
    ...(estimate.note ? { note: estimate.note } : {}),
    sent: estimate.sent !== false
  }
}

/** The next request's images, summed for the composer, and what to count for it. */
export const nextImages = (snapshot: {
  readonly request: Pick<AssembledRequest, "messages">
  readonly inputs: { readonly model: ModelInput | null }
}) => {
  const sent = snapshot.request.messages.flatMap((m) => m.images ?? []).filter((i) => i.estimate?.sent !== false)
  if (sent.length === 0) return {}
  const model = snapshot.inputs.model
  const uncounted = uncountedImages(snapshot.request)
  return {
    imageTokens: {
      count: sent.length,
      tokens: sent.reduce((n, image) => n + budgetTokens(image.estimate), 0),
      unknown: sent.filter((image) => (image.estimate?.tokens ?? null) === null).length,
      bases: [...new Set(sent.map((image) => image.estimate?.basis ?? "unknown"))]
    },
    ...(model && uncounted.length
      ? {
          uncounted: {
            connectionId: model.connectionId,
            kind: model.kind,
            modelKey: model.key,
            detail: SENT_DETAIL,
            images: uncounted
          }
        }
      : {})
  }
}

// What summarizing a chat's older history takes (spec/LCM.md §2.11): the work the planner
// would do from the chat's state now, counted in jobs and tokens. Pure: the reader supplies the
// chat's measurements, the main thread prices the counts. It follows the planner's rules
// (ARCHITECTURE §16): recent messages are kept down to their target, a pass is triggered above
// the midpoint of their target and maximum, a pass plans at most `MAX_JOBS_PER_PLAN` chunks, a chunk takes whole messages
// until it holds `leafInput` tokens, and `fanout` summaries of a level are condensed into one by
// the next pass, after its chunks.

import { estimateTokens } from "../assembler/st.ts"
import { MAX_CHUNK_SLOTS } from "../db/lcmLimits.ts"
import { MAX_JOBS_PER_PLAN } from "../db/lcmMaintain.ts"

/** The summarization instruction after the chunk, in estimated tokens. */
const TAIL_TOKENS = 80

/** The tags the layer puts around each summary and around them all (`layerText`), in estimated tokens. */
const SUMMARY_TAGS = estimateTokens('<summary level="1" from="1000" to="1100">\n\n</summary>\n')
const LAYER_TAGS = estimateTokens("<summaries>\n</summaries>")

/** A layer of summaries of these sizes as it is sent, tags included. */
export const layerTokens = (summaries: ReadonlyArray<number>) =>
  summaries.length ? LAYER_TAGS + summaries.reduce((n, tokens) => n + tokens + SUMMARY_TAGS, 0) : 0

export interface BackfillInput {
  /** The tokens and messages after the summaries' cursor, as the planner costs them. */
  readonly tokens: number
  readonly messages: number
  /** Recent messages' pair as the assembler fitted it, and the layer's maximum. */
  readonly recentTarget: number
  readonly recentMax: number
  readonly layerMax: number
  /**
   * False: requests without the preset (DESIGN §8), whose cached part is the instruction and the
   * continuity; with the preset it is the preset prefix and the layer, the instruction after the chunk.
   */
  readonly withPreset?: boolean
  /** The preset and cards that open every request. */
  readonly prefix: number
  /** What the layer holds before the work starts, in tokens, tags included (`layerTokens`). */
  readonly layer: number
  readonly leafInput: number
  readonly leafTarget: number
  readonly fanout: number
  readonly condenseTarget: number
  /** The model has a cache lifetime. */
  readonly cached: boolean
  /** The price charges for cache writes (explicit-breakpoint providers). */
  readonly cacheWrites: boolean
}

interface PlannedRequest {
  readonly uncachedInput: number
  readonly cachedInput: number
  readonly cacheWrite: number
  readonly output: number
}

export interface BackfillTotals {
  readonly plannedRequests: ReadonlyArray<PlannedRequest>
  readonly l1Jobs: number
  readonly condensations: number
  readonly uncachedInput: number
  readonly cachedInput: number
  readonly cacheWrite: number
  readonly output: number
  /** Requests made, for the duration. */
  readonly requests: number
  /** Tokens of messages the work summarizes. */
  readonly summarized: number
}

const EMPTY: BackfillTotals = {
  plannedRequests: [],
  l1Jobs: 0,
  condensations: 0,
  uncachedInput: 0,
  cachedInput: 0,
  cacheWrite: 0,
  output: 0,
  requests: 0,
  summarized: 0
}

/** A guard on the simulation: a chat of this many chunks is far past anything the estimate is for. */
const MAX_L1 = 2_000_000

/** A summary the simulated work adds to the layer: its level and its size as sent, tags included. */
interface Simulated {
  readonly level: number
  readonly tokens: number
}

/**
 * The jobs the planner would run for a chat with these measurements, and what each sends
 * and returns, in the planner's order: a pass plans its chunks, and condenses the runs of
 * `fanout` summaries of a level the layer held when it planned (`planMaintenance`); the
 * chunks run first, then the condensations. Passes go on until neither is left. A summary
 * request sends the preset, the layer and its chunk; a condensation sends the preset and the
 * layer up to its last part. Without the preset, the instruction takes the preset's place. With caching, a request reads back what it shares with the one
 * before from the start, and pays for the rest.
 */
export const estimateBackfill = (input: BackfillInput): BackfillTotals => {
  const { recentTarget, recentMax, leafInput, fanout } = input
  if (input.messages <= 0 || input.tokens <= 0 || recentMax <= 0 || leafInput <= 0) return EMPTY
  const keep = recentTarget
  const trigger = (recentTarget + recentMax) / 2
  const raw = input.withPreset === false
  // Without the preset the instruction opens the request and is read back with the continuity.
  const prefixTokens = raw ? TAIL_TOKENS : input.prefix
  const tailTokens = raw ? 0 : TAIL_TOKENS
  if (input.tokens <= trigger) return EMPTY
  // A chunk ends once it holds `leafInput` tokens, so it overshoots by half a message on average.
  const average = input.tokens / input.messages
  const chunk = Math.min(leafInput + average / 2, MAX_CHUNK_SLOTS * average)
  // Passes: each plans up to four chunks from what lies before the kept target, until recent
  // messages are under their trigger. The last chunk of a pass is whatever is left, so it can be small.
  let total = input.tokens
  const passes: Array<Array<number>> = []
  let l1Jobs = 0
  while (total > trigger && l1Jobs < MAX_L1) {
    let room = total - keep
    const pass: Array<number> = []
    while (room > 0 && pass.length < MAX_JOBS_PER_PLAN) {
      const size = Math.min(chunk, room)
      pass.push(size)
      room -= size
      total -= size
    }
    if (pass.length === 0) break
    passes.push(pass)
    l1Jobs += pass.length
  }

  // The summaries the work adds, oldest first, after what the layer held before it.
  const layer: Array<Simulated> = []
  // What a request sent before its own text: the layer before the work, then these summaries.
  let previous: ReadonlyArray<Simulated> | null = null
  const plannedRequests: PlannedRequest[] = []
  let uncached = 0
  let read = 0
  let write = 0
  let output = 0
  let condensations = 0
  let summarized = 0
  const sentLayer = (parts: ReadonlyArray<Simulated>) => {
    const tokens = parts.reduce((n, s) => n + s.tokens, input.layer)
    return Math.min(input.layer === 0 && parts.length ? tokens + LAYER_TAGS : tokens, input.layerMax)
  }
  const request = (body: number, parts: ReadonlyArray<Simulated>, returned: number) => {
    const before = [uncached, read, write]
    const layerSent = sentLayer(parts)
    if (!input.cached) uncached += body + prefixTokens + layerSent
    else {
      uncached += body
      // The preset and the layer before the work are the same in every request; the summaries
      // the work added are shared as far as both requests hold the same ones.
      let shared = 0
      if (previous) {
        let same = 0
        while (same < parts.length && same < previous.length && parts[same] === previous[same]) same++
        shared = prefixTokens + Math.min(layerSent, sentLayer(parts.slice(0, same)))
      }
      const cold = prefixTokens + layerSent - shared
      // What the provider has to be given afresh is written to the cache when it charges for that.
      if (input.cacheWrites) write += cold
      else uncached += cold
      read += shared
    }
    previous = parts
    output += returned
    plannedRequests.push({
      uncachedInput: Math.round(uncached - before[0]!),
      cachedInput: Math.round(read - before[1]!),
      cacheWrite: Math.round(write - before[2]!),
      output: returned
    })
  }
  for (let pass = 0; ; pass++) {
    // The planner condenses the runs of one level as the layer stands when it plans, `fanout` at a
    // time, the lowest level first.
    const groups: Array<Simulated> = []
    for (const level of [...new Set(layer.map((s) => s.level))].sort((x, y) => x - y))
      for (let at = 0; at < layer.length;) {
        let end = at
        while (end < layer.length && layer[end]!.level === layer[at]!.level) end++
        if (layer[at]!.level === level)
          for (let start = at; start + fanout <= end; start += fanout) groups.push(layer[start]!)
        at = end
      }
    groups.splice(MAX_JOBS_PER_PLAN)
    const chunks = passes[pass] ?? []
    if (!chunks.length && !groups.length) break
    for (const body of chunks) {
      summarized += body
      request(body + tailTokens, layer.slice(), input.leafTarget)
      layer.push({ level: 1, tokens: input.leafTarget + SUMMARY_TAGS })
    }
    // One at a time, each in the layer as the ones before it left it.
    for (const first of groups) {
      const at = layer.indexOf(first)
      condensations++
      request(tailTokens, layer.slice(0, at + fanout), input.condenseTarget)
      layer.splice(at, fanout, { level: first.level + 1, tokens: input.condenseTarget + SUMMARY_TAGS })
    }
  }
  const requests = l1Jobs + condensations
  return {
    plannedRequests,
    l1Jobs,
    condensations,
    uncachedInput: Math.round(uncached),
    cachedInput: Math.round(read),
    cacheWrite: Math.round(write),
    output: Math.round(output),
    requests,
    summarized: Math.round(summarized)
  }
}

/** Seconds for `requests` requests of the model, one at a time, from its recent speed. */
export const backfillSeconds = (
  totals: Pick<BackfillTotals, "requests" | "output">,
  speed: { readonly latencyS: number; readonly tokensPerSecond: number } | null
) =>
  speed === null || speed.tokensPerSecond <= 0
    ? null
    : Math.round(totals.requests * speed.latencyS + totals.output / speed.tokensPerSecond)

// What summarizing a chat's older history takes (spec/LCM.md §2.11): the work the planner
// would do from the chat's state now, counted in jobs and tokens. Pure: the reader supplies the
// chat's measurements, the main thread prices the counts. It follows the planner's rules
// (ARCHITECTURE §16): the newest half of the window is kept, a pass is triggered above three
// quarters of it, a pass plans at most `MAX_JOBS_PER_PLAN` chunks, a chunk takes whole messages
// until it holds `leafInput` tokens, and `fanout` summaries of a level are condensed into one.

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
  /** The window's budget for history (the assembler's), and the layer's maximum. */
  readonly windowMax: number
  readonly layerMax: number
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

/**
 * The jobs the planner would run for a chat with these measurements, and what each sends
 * and returns. With caching, the first request pays for the preset and the layer, and each
 * after it reads them back; a summary newly added to the layer is the one part of the next
 * request that was not in the one before.
 */
export const estimateBackfill = (input: BackfillInput): BackfillTotals => {
  const { windowMax, leafInput, fanout } = input
  if (input.messages <= 0 || input.tokens <= 0 || windowMax <= 0 || leafInput <= 0) return EMPTY
  const keep = windowMax * 0.5
  const trigger = windowMax * 0.75
  if (input.tokens <= trigger) return EMPTY
  // A chunk ends once it holds `leafInput` tokens, so it overshoots by half a message on average.
  const average = input.tokens / input.messages
  const chunk = Math.min(leafInput + average / 2, MAX_CHUNK_SLOTS * average)
  // Passes: each plans up to four chunks from what lies before the kept half, until the window is
  // under its trigger. The last chunk of a pass is whatever is left, so it can be small.
  let total = input.tokens
  const chunks: Array<number> = []
  while (total > trigger && chunks.length < MAX_L1) {
    let room = total - keep
    let made = 0
    while (room > 0 && made < MAX_JOBS_PER_PLAN) {
      const size = Math.min(chunk, room)
      chunks.push(size)
      room -= size
      total -= size
      made++
    }
    if (made === 0) break
  }

  // The layer as the jobs build it: counts of summaries per level.
  const counts: Array<number> = [0]
  // A summary as the layer sends it, in its tags.
  const size = (level: number) => (level === 1 ? input.leafTarget : input.condenseTarget) + SUMMARY_TAGS
  const layerNow = () => {
    let tokens = input.layer
    for (let level = 1; level < counts.length; level++) tokens += (counts[level] ?? 0) * size(level)
    if (input.layer === 0 && tokens > 0) tokens += LAYER_TAGS
    return Math.min(tokens, input.layerMax)
  }
  const plannedRequests: PlannedRequest[] = []
  let uncached = 0
  let read = 0
  let write = 0
  let output = 0
  let condensations = 0
  let requests = 0
  let summarized = 0
  // What of the layer the last request did not have: the summary added after it.
  let fresh = 0
  const request = (chunkTokens: number, layerBefore: number, newest: number) => {
    requests++
    const body = chunkTokens + TAIL_TOKENS
    if (!input.cached) {
      uncached += body + input.prefix + layerBefore
      return
    }
    uncached += body
    const warm = requests > 1
    const cold = warm ? newest : input.prefix + layerBefore
    // What the provider has to be given afresh is written to the cache when it charges for that.
    if (input.cacheWrites) write += cold
    else uncached += cold
    if (warm) read += input.prefix + Math.max(0, layerBefore - newest)
  }
  for (const body of chunks) {
    summarized += body
    const before = [uncached, read, write]
    request(body, layerNow(), fresh)
    plannedRequests.push({
      uncachedInput: Math.round(uncached - before[0]!),
      cachedInput: Math.round(read - before[1]!),
      cacheWrite: Math.round(write - before[2]!),
      output: input.leafTarget
    })
    output += input.leafTarget
    counts[1] = (counts[1] ?? 0) + 1
    fresh = size(1)
    // Condense whenever a level holds `fanout` summaries; a condensation can fill the level above.
    for (let level = 1; (counts[level] ?? 0) >= fanout; level++) {
      const previous = [uncached, read, write]
      requests++
      condensations++
      // Its request is the layer before its parts, the parts, and the instruction; the newest part is new.
      const parts = fanout * size(level)
      const before = Math.max(0, layerNow() - parts)
      const body = TAIL_TOKENS
      if (!input.cached) uncached += body + input.prefix + layerNow()
      else {
        uncached += body
        const cold = fresh
        if (input.cacheWrites) write += cold
        else uncached += cold
        read += input.prefix + Math.max(0, before + parts - cold)
      }
      plannedRequests.push({
        uncachedInput: Math.round(uncached - previous[0]!),
        cachedInput: Math.round(read - previous[1]!),
        cacheWrite: Math.round(write - previous[2]!),
        output: input.condenseTarget
      })
      output += input.condenseTarget
      counts[level] = (counts[level] ?? 0) - fanout
      counts[level + 1] = (counts[level + 1] ?? 0) + 1
      fresh = size(level + 1)
    }
  }
  return {
    plannedRequests,
    l1Jobs: chunks.length,
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

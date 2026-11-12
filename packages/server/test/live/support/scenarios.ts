// The live checks, shared by every provider's file. Each takes a profile (how to reach a
// model and what its provider documents) and records findings; a test fails at its end if
// any check failed, after all of them have run.
import { assert, it } from "@effect/vitest"
import type { LlmRequest } from "@rp/shared/usage.ts"
import type { Model } from "@rp/shared/providers.ts"
import { Effect, type Scope } from "effect"
import type { HttpServer } from "effect/http"
import type { Reader, Writer } from "../../../src/db/Database.ts"
import { client, serverLayer, testConfig } from "../../support/config.ts"
import {
  LIVE_TIMEOUT,
  liveKeys,
  startRecorder,
  type Exchange,
  type Findings,
  type LiveChat,
  type LiveChatOptions,
  type Turn,
  liveChat,
  near,
  sseEvents,
  wireUsage
} from "./live.ts"

type Api = Effect.Success<ReturnType<typeof client>>

/** How a provider reports cache usage. */
export type CacheDialect = "anthropic" | "openai" | "responses" | "deepseek" | "openrouter" | "google"

export interface Profile {
  /** The report's name for it: "anthropic", "openrouter→bedrock claude". */
  readonly id: string
  readonly kind: string
  readonly route: string
  readonly model: string
  /** The provider list's id for it, used as listed (with its catalog facts) instead of adding `model`. */
  readonly listed?: string
  /** The app knows no cache TTL for it, so it shows no warmth estimate (by design). */
  readonly ttlUnknown?: boolean
  readonly overrides?: LiveChatOptions["overrides"]
  readonly dialect: CacheDialect
  /** Card lore tokens that clear the provider's cache minimum comfortably. */
  readonly cacheTokens: number
  /** Documented prices per million (input, output, cache read, 5-minute write, 1-hour write). */
  readonly documented?: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite?: number
    readonly cacheWriteLong?: number
  }
}

export interface Counts {
  readonly uncached: number | null
  readonly read: number | null
  readonly write: number | null
  readonly writeLong: number | null
  readonly output: number | null
  readonly reasoning: number | null
  /** Read and write count the same tokens (OpenRouter's Gemini explicit cache). */
  readonly overlap?: boolean
}

const num = (v: unknown) => (typeof v === "number" ? v : null)
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {})

/** What the provider's own usage says, in our ledger's terms, read from the wire. */
export const wireCounts = (dialect: CacheDialect, u: Record<string, unknown> | null): Counts | null => {
  if (!u) return null
  if (dialect === "anthropic") {
    const write = num(u.cache_creation_input_tokens)
    return {
      uncached: num(u.input_tokens),
      read: num(u.cache_read_input_tokens),
      write,
      writeLong: num(obj(u.cache_creation).ephemeral_1h_input_tokens),
      output: num(u.output_tokens),
      reasoning: null
    }
  }
  if (dialect === "responses") {
    const input = num(u.input_tokens)
    const read = num(obj(u.input_tokens_details).cached_tokens) ?? 0
    return {
      uncached: input === null ? null : input - read,
      read,
      write: num(obj(u.input_tokens_details).cache_write_tokens),
      writeLong: null,
      output: num(u.output_tokens),
      reasoning: num(obj(u.output_tokens_details).reasoning_tokens)
    }
  }
  if (dialect === "google") {
    // usageMetadata: the prompt count includes the cached tokens; the output is the reply's
    // tokens plus the thoughts'.
    const prompt = num(u.promptTokenCount)
    const read = num(u.cachedContentTokenCount) ?? 0
    const thoughts = num(u.thoughtsTokenCount)
    const candidates = num(u.candidatesTokenCount)
    return {
      uncached: prompt === null ? null : prompt - read,
      read,
      write: null,
      writeLong: null,
      output: candidates === null && thoughts === null ? null : (candidates ?? 0) + (thoughts ?? 0),
      reasoning: thoughts ?? 0
    }
  }
  const prompt = num(u.prompt_tokens)
  const details = obj(u.prompt_tokens_details)
  const read = dialect === "deepseek" ? (num(u.prompt_cache_hit_tokens) ?? 0) : (num(details.cached_tokens) ?? 0)
  const write = num(details.cache_write_tokens)
  // OpenRouter's Gemini explicit cache writes the prefix and reads it in the same request.
  const overlap = dialect === "openrouter" && prompt !== null && prompt < read + (write ?? 0)
  return {
    uncached:
      prompt === null
        ? null
        : overlap
          ? prompt - Math.max(read, write ?? 0)
          : prompt - read - (dialect === "openrouter" ? (write ?? 0) : 0),
    read,
    write,
    writeLong: null,
    output: num(u.completion_tokens),
    reasoning: num(obj(u.completion_tokens_details).reasoning_tokens),
    ...(overlap ? { overlap } : {})
  }
}

export const totalInput = (c: Counts | LlmRequest["counts"] | null | undefined) => {
  if (!c) return 0
  if ("uncached" in c)
    return (c.uncached ?? 0) + (c.overlap ? Math.max(c.read ?? 0, c.write ?? 0) : (c.read ?? 0) + (c.write ?? 0))
  return (c.inputUncached ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0)
}

/** A turn's request id at the provider, for the report. */
const ref = (t: Turn | undefined) => (t?.exchange ? Object.values(t.exchange.ids)[0] : undefined)

/**
 * The checks every reply gets: it completed, our counts equal the provider's usage from the
 * wire, and our cost equals the documented prices applied to that usage (or OpenRouter's own
 * figure). Returns the provider's counts.
 */
export const checkTurn = (
  f: Findings,
  p: Profile,
  label: string,
  t: Turn,
  model: Model | null,
  /** Stops the turn is meant to end with (a reply cut at its output limit on purpose). */
  stops: ReadonlyArray<string> = []
) => {
  const row = t.row
  if (row) f.addSpend(p.id, row, t.stored.at(-1)?.reportedCost ?? null)
  const stopped = t.version.error?.class !== undefined && stops.includes(t.version.error.class)
  f.check(p.id, `${label}: reply completes`, t.version.status === "complete" || stopped, {
    expected: stops.length > 0 ? ["complete", ...stops] : "complete",
    actual: {
      status: t.version.status,
      error: t.version.error,
      http: t.exchange?.status,
      body: t.exchange?.status === 200 ? undefined : t.exchange?.body.slice(0, 400)
    },
    ref: ref(t)
  })
  if (!row || !t.exchange) {
    f.check(p.id, `${label}: ledger row and request recorded`, false, {
      actual: { row: !!row, exchange: !!t.exchange }
    })
    return null
  }
  const wire = wireCounts(p.dialect, wireUsage(t.exchange.body))
  if (!wire) {
    f.check(p.id, `${label}: provider reported usage`, false, { actual: t.exchange.body.slice(-400), ref: ref(t) })
    return null
  }
  const ours = row.counts
  const same =
    ours.inputUncached === wire.uncached &&
    ours.cacheRead === wire.read &&
    (ours.cacheWrite ?? 0) === (wire.write ?? 0) &&
    ours.output === wire.output &&
    (wire.reasoning === null || (ours.reasoning ?? 0) === wire.reasoning) &&
    (wire.writeLong === null || (ours.cacheWriteLong ?? 0) === wire.writeLong)
  f.check(p.id, `${label}: ledger counts = provider usage`, same, {
    expected: wire,
    actual: ours,
    ref: ref(t)
  })
  f.check(p.id, `${label}: usage source reported`, row.usageSource === "reported", { actual: row.usageSource })
  // Cost.
  const stored = t.stored.at(-1)
  if (p.dialect === "openrouter") {
    const reported = num(obj(wireUsage(t.exchange.body)).cost)
    f.check(
      p.id,
      `${label}: cost = OpenRouter's reported cost`,
      reported !== null && row.cost !== null && Math.abs(row.cost.amount - reported) < 1e-9,
      {
        expected: reported,
        actual: { cost: row.cost, reportedCost: row.reportedCost, formula: stored?.costFormula },
        ref: ref(t)
      }
    )
    const price = model?.upstream.price
    // OpenRouter lists one price per model; a model whose providers charge differently is billed
    // at the pinned provider's own price (liveapi2: DeepSeek via DeepInfra, gpt-oss on Bedrock).
    // A first-party model on its own vendor's cloud keeps the listed price.
    const routing = p.overrides?.settings?.routing as { only?: ReadonlyArray<string> } | undefined
    const vendorClouds: Record<string, ReadonlyArray<string>> = {
      anthropic: ["anthropic", "google-vertex", "amazon-bedrock"],
      openai: ["openai", "azure"],
      google: ["google-vertex", "google-ai-studio"]
    }
    const clouds = vendorClouds[p.model.split("/")[0] ?? ""] ?? []
    const ownPrice = !routing?.only || routing.only.every((slug) => clouds.includes(slug))
    if (price && reported !== null) {
      const listed = priceOf(price, wire, false)
      f.check(
        p.id,
        `${label}: listed price × usage ≈ OpenRouter's billed cost (cache write premium)`,
        ownPrice ? Math.abs(listed - reported) <= Math.max(1e-7, reported * 0.02) : null,
        {
          expected: reported,
          actual: { fromListedPrice: listed, price },
          ref: ref(t)
        }
      )
    }
  } else {
    const price = model?.upstream.price
    const expected = p.documented ? priceOf(p.documented, wire, true) : price ? priceOf(price, wire, false) : null
    f.check(
      p.id,
      `${label}: cost = ${p.documented ? "documented" : "catalog"} price × provider usage`,
      expected === null
        ? null
        : row.cost !== null && Math.abs(row.cost.amount - expected) <= Math.max(1e-9, expected * 0.005),
      { expected, actual: { cost: row.cost, formula: stored?.costFormula, catalogPrice: price ?? null }, ref: ref(t) }
    )
  }
  return wire
}

/** Cost of `c` at per-million prices; writes at the documented premiums when not given. */
const priceOf = (
  price: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cacheWriteLong?: number },
  c: Counts,
  documented: boolean
) => {
  const long = c.writeLong ?? 0
  const short = (c.write ?? 0) - long
  const writeRate = price.cacheWrite ?? price.input
  const longRate = documented ? (price.cacheWriteLong ?? price.input * 2) : price.input * 2
  return (
    ((c.uncached ?? 0) * price.input +
      (c.read ?? 0) * (price.cacheRead ?? price.input) +
      short * writeRate +
      long * longRate +
      (c.output ?? 0) * price.output) /
    1e6
  )
}

/** The cache markers in a request body: where they are and their TTLs. */
export const markers = (exchange: Exchange | undefined) => {
  const out: Array<{ at: string; ttl: string | null }> = []
  const body = exchange?.request
  if (!body) return out
  const visit = (value: unknown, at: string) => {
    if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${at}[${i}]`))
    else if (value && typeof value === "object") {
      const o = value as Record<string, unknown>
      if (o.cache_control) out.push({ at, ttl: (obj(o.cache_control).ttl as string | undefined) ?? null })
      if (o.prompt_cache_breakpoint) out.push({ at, ttl: null })
      for (const [k, v] of Object.entries(o)) if (k !== "cache_control") visit(v, `${at}.${k}`)
    }
  }
  visit(body, "")
  return out
}

// ---------------------------------------------------------------------------------------
// Scenarios.

/** Model list and capabilities: refreshes the connection's list, returns the model used. */
export const checkModels = (
  f: Findings,
  p: Profile,
  api: Api,
  chat: LiveChat,
  expectations: {
    readonly listed: string
    readonly context?: number
    readonly vision?: boolean
    readonly reasoning?: boolean
  }
) =>
  Effect.gen(function* () {
    const refresh = yield* api.RefreshModels({ connectionId: chat.connection.id }).pipe(Effect.result)
    const models = yield* api.ListModels({ connectionId: chat.connection.id, includeHidden: true })
    const found = models.find((m) => m.key === expectations.listed)
    f.check(p.id, "model list fetched and contains the model", refresh._tag === "Success" && found !== undefined, {
      expected: expectations.listed,
      actual: {
        refresh: refresh._tag === "Success" ? "ok" : String(refresh.failure),
        count: models.length,
        sample: models.slice(0, 5).map((m) => m.key)
      }
    })
    const used = models.find((m) => m.id === chat.model.id) ?? null
    if (found) {
      const u = found.upstream
      f.check(
        p.id,
        "listed model capabilities (context, vision, reasoning, price)",
        (expectations.context === undefined || u.context === expectations.context) &&
          (expectations.vision === undefined || u.vision === expectations.vision) &&
          (expectations.reasoning === undefined || u.reasoning === expectations.reasoning) &&
          u.price !== undefined,
        {
          expected: { ...expectations, price: "present" },
          actual: {
            context: u.context,
            vision: u.vision,
            reasoning: u.reasoning,
            price: u.price,
            cacheTtlS: u.cacheTtlS,
            catalog: u.catalog
          }
        }
      )
    }
    return used
  })

/** Tokens after a request's last cache marker that the next request needn't share. */
const TAIL = 32

/**
 * A growing chat: four turns, a swipe, a deep edit. Compares each request's real cache
 * read/write with the previous request and with our next-context estimate.
 */
export const growingChat = (f: Findings, p: Profile, chat: LiveChat, model: Model | null) =>
  Effect.gen(function* () {
    const turns: Array<{ t: Turn; wire: Counts | null }> = []
    // OpenAI's cache is best effort (livefix): what it reads is recorded, not required, and our
    // estimate must only not claim more than it reads.
    const bestEffort = p.dialect === "openai" || p.dialect === "responses"
    const lines = [
      "Good evening, Mira. Is the copper bell entry still in the ledger?",
      "Then read me the entry about the amber lantern, please.",
      "What does the keeper of the boatyard do at low tide?",
      "Thank you. One more: who guards the white compass?"
    ]
    for (const [i, line] of lines.entries()) {
      const t = (yield* chat.say(line))!
      const wire = checkTurn(f, p, `turn ${i + 1}`, t, model)
      turns.push({ t, wire })
      const prev = turns.at(-2)
      if (i === 0) {
        f.check(p.id, "turn 1: fresh prefix reads nothing", (wire?.read ?? 0) === 0, { actual: wire, ref: ref(t) })
        if (p.dialect === "anthropic" || p.dialect === "openrouter")
          f.check(p.id, "turn 1: cache written", (wire?.write ?? 0) > 0, { actual: wire, ref: ref(t) })
      } else if (prev?.wire && wire) {
        const prevTotal = totalInput(prev.wire)
        if (p.dialect === "anthropic" || (p.dialect === "openrouter" && (prev.wire.write ?? 0) > 0)) {
          // Lookback: the previous prompt up to its last marker is a prefix of this one, so it
          // reads all of it; the few tokens after that marker (the request's volatile tail)
          // are sent again.
          const expected = (prev.wire.read ?? 0) + (prev.wire.write ?? 0)
          const read = wire.read ?? 0
          f.check(
            p.id,
            `turn ${i + 1}: reads the whole previous prompt (up to a ≤ ${TAIL}-token tail)`,
            read <= expected && read >= expected - TAIL,
            {
              expected: { read: expected, tolerance: TAIL },
              actual: { read: wire.read, write: wire.write, uncached: wire.uncached },
              ref: ref(t)
            }
          )
        } else {
          f.check(
            p.id,
            `turn ${i + 1}: automatic cache reads most of the previous prompt`,
            bestEffort ? null : (wire.read ?? 0) >= 0.7 * prevTotal,
            {
              expected: { readAtLeast: Math.round(0.7 * prevTotal), previousPrompt: prevTotal },
              actual: { read: wire.read, uncached: wire.uncached },
              ref: ref(t)
            }
          )
        }
        // Our estimate, read before the request.
        const w = t.before?.warmth
        if (!w && p.ttlUnknown) {
          f.check(p.id, `turn ${i + 1}: estimate says warm, prefix unchanged`, null, {
            actual: "no estimate: the app knows no cache TTL for this provider"
          })
          continue
        }
        f.check(
          p.id,
          `turn ${i + 1}: estimate says warm, prefix unchanged`,
          !!w && w.changed === null && (w.ttlS === null || Date.now() < (w.expiresAt ?? Infinity)),
          {
            expected: "warmth with changed: null",
            actual: w ?? null
          }
        )
        if (w && bestEffort)
          f.check(
            p.id,
            `turn ${i + 1}: estimated cached prefix claims no more than the provider read`,
            w.prefixTokens <= (wire.read ?? 0) * 1.4,
            {
              expected: { providerRead: wire.read },
              actual: { estimatePrefixTokens: w.prefixTokens, verified: w.verified, ttlS: w.ttlS }
            }
          )
        else if (w)
          f.check(
            p.id,
            `turn ${i + 1}: estimated cached prefix ≈ provider's cached tokens (±40%)`,
            near(w.prefixTokens, wire.read ?? 0, 1.4),
            {
              expected: { providerRead: wire.read },
              actual: { estimatePrefixTokens: w.prefixTokens, verified: w.verified, ttlS: w.ttlS }
            }
          )
      }
    }
    // A swipe of the last reply: the same request again.
    const last = turns.at(-1)!
    const s = yield* chat.swipe
    const sw = checkTurn(f, p, "swipe", s, model)
    if (sw && last.wire) {
      const full = totalInput(last.wire)
      f.check(
        p.id,
        "swipe: reads (nearly) the whole prompt",
        bestEffort ? null : (sw.read ?? 0) >= (p.dialect === "anthropic" ? full - TAIL : 0.8 * full),
        {
          expected: { read: full, tolerance: p.dialect === "anthropic" ? TAIL : "80%" },
          actual: sw,
          ref: ref(s)
        }
      )
      const none = (w: unknown) => !w && p.ttlUnknown
      f.check(
        p.id,
        "swipe: estimate for the swipe's request says unchanged",
        none(s.before?.warmth) ? null : s.before?.warmth?.changed === null,
        {
          actual: s.before?.warmth ?? null
        }
      )
      f.check(
        p.id,
        "swipe: estimate shown at the leaf (what the chip shows) agrees",
        none(s.shown?.warmth) ? null : s.shown?.warmth?.changed === null,
        {
          actual: s.shown?.warmth ?? null
        }
      )
    }
    // An edit deep in history: the user's first message.
    yield* chat.edit(1, "Good evening, Mira. Is the rust-red anchor entry still in the ledger?")
    const e = (yield* chat.say("Now, the entry about the violet sail."))!
    const ew = checkTurn(f, p, "after deep edit", e, model)
    const changed = e.before?.warmth?.changed
    f.check(p.id, "deep edit: estimate says the prefix changed", !e.before?.warmth && p.ttlUnknown ? null : !!changed, {
      actual: e.before?.warmth ?? null
    })
    if (ew)
      f.check(
        p.id,
        "deep edit: the system part still reads from cache",
        bestEffort ? null : (ew.read ?? 0) > 0 && (ew.read ?? 0) < totalInput(ew) * 0.95,
        {
          actual: ew,
          ref: ref(e)
        }
      )
    if (ew && changed) {
      const uncachedNow = (ew.uncached ?? 0) + (ew.write ?? 0)
      f.check(
        p.id,
        "deep edit: estimated re-sent tokens ≈ provider's uncached+written (±50%)",
        near(changed.tokens, uncachedNow, 1.5),
        {
          expected: { providerUncachedPlusWritten: uncachedNow, providerRead: ew.read },
          actual: { estimate: changed.tokens, reason: changed.reason }
        }
      )
    }
    return { turns, swipe: s, edit: e }
  })

/** Stop mid-stream: the version stops, the HTTP request is cut, the row closes as aborted. */
export const stopMidStream = (f: Findings, p: Profile, chat: LiveChat) =>
  Effect.gen(function* () {
    const t = yield* chat.stopAfter("Please recite every entry of the archive, one per line, slowly.", 40)
    if (t.row) f.addSpend(p.id, t.row, null)
    f.check(
      p.id,
      "stop mid-stream: version stopped with the streamed text kept",
      t.version.status === "stopped" && t.version.content.length >= Math.min(t.stoppedAt, 1),
      {
        actual: {
          status: t.version.status,
          chars: t.version.content.length,
          stoppedAt: t.stoppedAt,
          error: t.version.error
        }
      }
    )
    f.check(
      p.id,
      "stop mid-stream: HTTP request aborted and ledger row aborted",
      !!t.exchange?.aborted && t.row?.status === "aborted",
      {
        actual: {
          aborted: t.exchange?.aborted,
          row: t.row?.status,
          output: t.row?.counts.output,
          source: t.row?.usageSource
        }
      }
    )
    f.check(p.id, "stop mid-stream: output counted (at least the text that arrived)", (t.row?.counts.output ?? 0) > 0, {
      actual: { output: t.row?.counts.output, source: t.row?.usageSource }
    })
    return t
  })

/** Display-only buffering: `stream: false` still streams on the wire (the app has no non-streaming request). */
export const nonStreaming = (f: Findings, p: Profile, chat: LiveChat) =>
  Effect.gen(function* () {
    const t = (yield* chat.say("One short sentence, please."))!
    const deltas = chat.events.filter((e) => e._tag === "Delta" && e.versionId === t.version.id).length
    f.check(
      p.id,
      "stream off: reply arrives whole (one delta), wire request still streams",
      t.version.status === "complete" && deltas <= 1,
      {
        actual: { status: t.version.status, deltas, wireStream: t.exchange?.request?.stream }
      }
    )
    return t
  })

export const streaming = (f: Findings, p: Profile, t: Turn, events: LiveChat["events"]) => {
  const deltas = events.filter((e) => e._tag === "Delta" && e.versionId === t.version.id).length
  f.check(p.id, "streaming: text arrives in several deltas", deltas > 1, {
    actual: { deltas, sseEvents: t.exchange ? sseEvents(t.exchange.body).length : 0 }
  })
}

/** A failing request's class and text as the version shows it. */
export const errorCase = (f: Findings, p: Profile, name: string, t: Turn, expectedClass: ReadonlyArray<string>) => {
  f.check(
    p.id,
    `error ${name}: mapped to ${expectedClass.join("/")}`,
    t.version.status === "failed" && expectedClass.includes(t.version.error?.class ?? ""),
    {
      expected: expectedClass,
      actual: {
        status: t.version.status,
        error: t.version.error,
        http: t.exchange?.status,
        providerBody: t.exchange?.body.slice(0, 300),
        ledger: t.row?.status
      },
      ref: ref(t)
    }
  )
}

/**
 * A live test with its own server, recorder and findings; fails at the end listing every
 * failed check (all checks run first).
 */
export const liveTest = <E>(
  name: string,
  f: Findings,
  body: (ctx: {
    readonly api: Api
    readonly recorder: Awaited<ReturnType<typeof startRecorder>>
    readonly dataDir: string
  }) => Effect.Effect<void, E, Writer | Reader | Scope.Scope | HttpServer.HttpServer>
) =>
  it.live(
    name,
    () => {
      const config = testConfig()
      const before = f.failures().length
      return Effect.gen(function* () {
        const recorder = yield* Effect.acquireRelease(
          Effect.promise(() => startRecorder(liveKeys())),
          (r) => Effect.promise(() => r.close())
        )
        const api = yield* client()
        yield* body({ api, recorder, dataDir: config.dataDir })
        const failed = f.failures().slice(before)
        assert.deepStrictEqual(
          failed.map((x) => `${x.provider} · ${x.check}`),
          [],
          JSON.stringify(failed, null, 1).slice(0, 4000)
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config))) as Effect.Effect<void, unknown, never>
    },
    LIVE_TIMEOUT
  )

export { ref }
export const startChat = (
  api: Api,
  recorder: Parameters<typeof liveChat>[1],
  dataDir: string,
  p: Profile,
  options: Partial<LiveChatOptions> = {}
) =>
  liveChat(api, recorder, dataDir, {
    kind: p.kind,
    route: p.route,
    model: p.model,
    ...(p.listed ? { listed: p.listed } : {}),
    overrides: { ...p.overrides, ...options.overrides },
    cardTokens: p.cacheTokens,
    ...options
  })

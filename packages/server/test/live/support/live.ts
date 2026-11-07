// Live provider suite support (`npm run test:live`, never part of `npm run check`).
//
// The suite drives the app's own provider code (connections, adapters, assembler, cache
// layout, usage ledger and cost formulas) against the providers' real APIs.
// Between the app and the provider sits a pass-through recorder, so each check can compare
// what the app sent and stored with what the provider actually received and answered. It
// never builds a provider request itself.
//
// Configuration (environment):
// - RP_LIVE_KEY_FILE: path of a file holding the API key. Unset: the suite is skipped.
//   The key is read here, given to the app as a connection key, and never logged or stored.
// - RP_LIVE_BASE: base URL of the provider router (default http://127.0.0.1:8080, routes /<upstream>/…).
// - RP_LIVE_OUT: where results go (default <work>/artifacts/liveapi/results).
// - RP_LIVE_WAIT_TTL=1: also run the checks that wait out a 5-minute cache lifetime.
//
// Content is synthetic and SFW: generated harbor-town lore, no owner data.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { deflateSync } from "node:zlib"
import { NewVersion, type Chat, type EntityId, type SlotId, type Version, type VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { NextContext, RunContext } from "@rp/shared/inspectorApi.ts"
import type { Model, ModelOverrides } from "@rp/shared/providers.ts"
import type { StateEventData } from "@rp/shared/state.ts"
import type { LlmRequest } from "@rp/shared/usage.ts"
import { Effect, Stream } from "effect"
import { Writer } from "../../../src/db/Database.ts"
import { databaseFile } from "../../../src/db/connection.ts"
import { importStPreset } from "../../../src/formats/preset.ts"
import { chunk, PNG_SIGNATURE } from "../../formats/support.ts"
import { type client, posted, serverPort } from "../../support/config.ts"
import { cardDoc } from "../../support/docs.ts"

export const LIVE = {
  keyFile: process.env.RP_LIVE_KEY_FILE,
  base: process.env.RP_LIVE_BASE ?? "http://127.0.0.1:8080",
  out: process.env.RP_LIVE_OUT ?? "<work>/artifacts/liveapi/results",
  waitTtl: process.env.RP_LIVE_WAIT_TTL === "1"
}
export const liveEnabled = !!LIVE.keyFile && !process.env.CI
export const liveKey = () => readFileSync(LIVE.keyFile!, "utf8").trim()
/** Live tests run for minutes: replies, waits for caches to settle, retries upstream. */
export const LIVE_TIMEOUT = 900_000

// ---------------------------------------------------------------------------------------
// The recorder: a loopback pass-through to the provider that keeps each exchange.

export interface Exchange {
  readonly path: string
  readonly request: Record<string, unknown> | null
  status: number
  /** Response headers that identify the request upstream (never auth headers). */
  ids: Record<string, string>
  body: string
  aborted: boolean
  done: boolean
}

/**
 * Every exchange, appended to `<RP_LIVE_OUT>/exchanges-<pid>.jsonl` for later reading: the
 * request body (synthetic content), status, upstream ids and the response, key redacted.
 */
const keep = (exchange: Exchange) => {
  mkdirSync(LIVE.out, { recursive: true })
  appendFileSync(
    join(LIVE.out, `exchanges-${process.pid}.jsonl`),
    JSON.stringify({ ...exchange, body: exchange.body.slice(0, 20_000) }) + "\n"
  )
}

const ID_HEADERS = ["request-id", "x-request-id", "x-ds-trace-id", "x-generation-id", "x-openrouter-generation-id"]

export const startRecorder = (key: string) =>
  new Promise<{ url: string; exchanges: Array<Exchange>; close: () => Promise<void> }>((resolve) => {
    const exchanges: Array<Exchange> = []
    const redact = (text: string) => text.split(key).join("<redacted>")
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Array<Buffer> = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        const raw = Buffer.concat(chunks)
        let request: Record<string, unknown> | null = null
        try {
          request = raw.length ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : null
        } catch {
          request = null
        }
        const exchange: Exchange = {
          path: req.url ?? "",
          request,
          status: 0,
          ids: {},
          body: "",
          aborted: false,
          done: false
        }
        exchanges.push(exchange)
        const controller = new AbortController()
        res.on("close", () => {
          if (!exchange.done) {
            exchange.aborted = true
            controller.abort()
          }
        })
        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) {
          if (["host", "content-length", "connection", "accept-encoding"].includes(name) || value === undefined)
            continue
          headers.set(name, Array.isArray(value) ? value.join(", ") : value)
        }
        fetch(LIVE.base + exchange.path, {
          method: req.method ?? "GET",
          headers,
          ...(raw.length ? { body: raw } : {}),
          signal: controller.signal
        })
          .then(async (upstream) => {
            exchange.status = upstream.status
            for (const name of ID_HEADERS) {
              const value = upstream.headers.get(name)
              if (value) exchange.ids[name] = value
            }
            const out: Record<string, string> = {}
            upstream.headers.forEach((value, name) => {
              if (!["content-length", "content-encoding", "transfer-encoding", "connection"].includes(name))
                out[name] = value
            })
            res.writeHead(upstream.status, out)
            const decoder = new TextDecoder()
            if (upstream.body) {
              const reader = upstream.body.getReader()
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                exchange.body += redact(decoder.decode(value, { stream: true }))
                res.write(value)
              }
            }
            exchange.done = true
            res.end()
            keep(exchange)
          })
          .catch((error: unknown) => {
            if (!exchange.aborted) {
              exchange.status = exchange.status || 599
              exchange.body += redact(String(error))
              exchange.done = true
              res.destroy()
            }
            keep(exchange)
          })
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        exchanges,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => done())
          })
      })
    })
  })

/** The JSON objects of an SSE body (or the whole body when it is plain JSON). */
export const sseEvents = (body: string): Array<Record<string, unknown>> => {
  const out: Array<Record<string, unknown>> = []
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") continue
    try {
      out.push(JSON.parse(data) as Record<string, unknown>)
    } catch {
      // A partial line at an abort.
    }
  }
  if (out.length === 0) {
    try {
      out.push(JSON.parse(body) as Record<string, unknown>)
    } catch {
      // Not JSON.
    }
  }
  return out
}

/**
 * The usage the provider itself streamed, merged over the stream's events: Anthropic's
 * message_start usage then message_delta's, OpenAI-style chunks' `usage`, Responses'
 * `response.completed`.
 */
export const wireUsage = (body: string): Record<string, unknown> | null => {
  let usage: Record<string, unknown> | null = null
  for (const event of sseEvents(body)) {
    const found =
      (event.message as { usage?: Record<string, unknown> } | undefined)?.usage ??
      (event.response as { usage?: Record<string, unknown> } | undefined)?.usage ??
      (event.usage as Record<string, unknown> | undefined)
    if (found && typeof found === "object") usage = Object.assign({}, usage, found)
  }
  return usage
}

// ---------------------------------------------------------------------------------------
// Findings: soft checks written to a JSON file per test file, so a run's report can list
// every mismatch with its numbers.

export interface Finding {
  readonly provider: string
  readonly check: string
  readonly pass: boolean | null
  readonly expected?: unknown
  readonly actual?: unknown
  readonly ref?: string | undefined
}

export const findings = (file: string) => {
  const all: Array<Finding> = []
  const spend: Record<string, { cost: number; reported: number; requests: number; tokens: Record<string, number> }> = {}
  const write = () => {
    mkdirSync(LIVE.out, { recursive: true })
    writeFileSync(join(LIVE.out, `${file}.json`), JSON.stringify({ findings: all, spend }, null, 2))
  }
  return {
    all,
    spend,
    /** A check: `pass` null is a blocked or skipped check. */
    check: (
      provider: string,
      check: string,
      pass: boolean | null,
      details: Omit<Finding, "provider" | "check" | "pass"> = {}
    ) => {
      all.push({ provider, check, pass, ...details })
      process.stdout.write(
        `[live] ${pass === null ? "SKIP" : pass ? "PASS" : "FAIL"} ${provider} · ${check}${pass ? "" : ` ${JSON.stringify(details).slice(0, 600)}`}\n`
      )
      write()
      return pass
    },
    addSpend: (provider: string, row: LlmRequest, reported: number | null) => {
      const s = (spend[provider] ??= { cost: 0, reported: 0, requests: 0, tokens: {} })
      s.requests++
      s.cost += row.cost?.amount ?? 0
      s.reported += reported ?? 0
      for (const [k, v] of Object.entries(row.counts)) if (typeof v === "number") s.tokens[k] = (s.tokens[k] ?? 0) + v
      write()
    },
    failures: () => all.filter((f) => f.pass === false),
    write
  }
}
export type Findings = ReturnType<typeof findings>

/** `actual` within `ratio` of `expected` (both ways), for estimate-against-provider checks. */
export const near = (actual: number, expected: number, ratio: number) =>
  expected === 0 ? actual === 0 : actual / expected <= ratio && expected / actual <= ratio

// ---------------------------------------------------------------------------------------
// Synthetic content.

const WORDS = {
  place: ["harbor", "lighthouse", "fish market", "rope walk", "chapel", "boatyard", "tide pool", "ferry pier"],
  thing: ["lantern", "ledger", "net", "anchor", "kettle", "map", "bell", "compass", "sail", "oar"],
  color: ["blue", "amber", "grey", "green", "copper", "white", "rust-red", "violet"],
  verb: ["mends", "counts", "paints", "polishes", "carries", "records", "sorts", "guards"],
  time: ["at dawn", "after the noon bell", "on market days", "when the fog rolls in", "every spring", "at low tide"]
}

/** Deterministic synthetic lore of about `tokens` tokens (four characters each), led by `nonce`. */
const lore = (nonce: string, tokens: number, seed = 1) => {
  let state = seed * 2654435761
  const pick = <A>(list: ReadonlyArray<A>) => {
    state = (state * 1103515245 + 12345) >>> 0
    return list[state % list.length]!
  }
  const lines = [`Archive ${nonce}.`]
  let length = lines[0]!.length
  let n = 0
  while (length < tokens * 4) {
    const line = `Entry ${++n}: the keeper of the ${pick(WORDS.place)} ${pick(WORDS.verb)} the ${pick(WORDS.color)} ${pick(WORDS.thing)} ${pick(WORDS.time)}, and the townsfolk call it the ${pick(WORDS.color)} ${pick(WORDS.thing)} of the ${pick(WORDS.place)}.`
    lines.push(line)
    length += line.length + 1
  }
  return lines.join("\n")
}

/** A `size`×`size` PNG of one solid colour (RGB), for vision checks. */
export const solidPng = (rgb: readonly [number, number, number], size = 64) => {
  const row = Buffer.alloc(1 + size * 3)
  for (let x = 0; x < size; x++) row.set(rgb, 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND")])
}

// ---------------------------------------------------------------------------------------
// A live chat through the app.

type Api = Effect.Success<ReturnType<typeof client>>

const eventually = (check: () => boolean, ms = 240_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("timed out waiting"))
      yield* Effect.sleep(50)
    }
  })

const lastVersion = (events: ReadonlyArray<ChatEvent>, id: VersionId) =>
  events.flatMap((e) => (e._tag === "Version" && e.version.id === id ? [e.version] : [])).at(-1)
const finished = (events: ReadonlyArray<ChatEvent>, id: VersionId) => {
  const v = lastVersion(events, id)
  return v && v.status !== "generating" ? v : undefined
}

/** A ledger row as stored, with the provider's raw usage. */
export interface StoredRequest {
  readonly id: string
  readonly status: string
  readonly raw: Record<string, unknown> | null
  readonly error: unknown
  readonly costFormula: string | null
  readonly reportedCost: number | null
  readonly upstream: string | null
  readonly estimatedInput: number | null
}

const storedRequests = (dataDir: string, versionId: VersionId): Array<StoredRequest> => {
  const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
  try {
    return (
      db
        .prepare(
          "SELECT id, status, raw_usage_json, error_json, cost_formula, reported_cost, upstream, estimated_input FROM llm_requests WHERE version_id = ? ORDER BY started_at"
        )
        .all(versionId) as Array<Record<string, string | number | null>>
    ).map((r) => ({
      id: String(r.id),
      status: String(r.status),
      raw: r.raw_usage_json ? (JSON.parse(String(r.raw_usage_json)) as Record<string, unknown>) : null,
      error: r.error_json ? JSON.parse(String(r.error_json)) : null,
      costFormula: (r.cost_formula as string | null) ?? null,
      reportedCost: (r.reported_cost as number | null) ?? null,
      upstream: (r.upstream as string | null) ?? null,
      estimatedInput: (r.estimated_input as number | null) ?? null
    }))
  } finally {
    db.close()
  }
}

export interface Turn {
  readonly version: Version
  /** The ledger rows of this version, newest last. */
  readonly rows: ReadonlyArray<LlmRequest>
  readonly row: LlmRequest | undefined
  readonly stored: ReadonlyArray<StoredRequest>
  /** The exchanges the recorder saw for this turn (retries included). */
  readonly exchanges: ReadonlyArray<Exchange>
  readonly exchange: Exchange | undefined
  /** The next-context estimate read just before the request was made. */
  readonly before: NextContext | null
  readonly run: RunContext | null
}

export interface LiveChatOptions {
  readonly kind: string
  /** The provider route: `anthropic`, `openai/v1`, `openrouter/v1`, `deepseek/v1`. */
  readonly route: string
  readonly model: string
  /** Use the provider's listed model of this id (after a refresh) instead of adding `model`. */
  readonly listed?: string
  readonly overrides?: ModelOverrides
  /** Fields of ST's default preset to change (its samplers, prompts, order). */
  readonly preset?: Record<string, unknown>
  /** Changes to ST's default preset file before it is imported, as a user's ST preset would be. */
  readonly stPreset?: (st: Record<string, unknown>) => Record<string, unknown>
  /** The preset's assistant prefill. */
  readonly prefill?: string
  /** Tokens of synthetic lore in each card's description. */
  readonly cardTokens: number
  /** Cards in the chat: Mira first, then these. */
  readonly characters?: ReadonlyArray<string>
  readonly greeting?: string | null
  readonly state?: ReadonlyArray<StateEventData>
  readonly cardFields?: Partial<CardDoc>
  /** Use this key instead of the provider key (bad-key checks). */
  readonly apiKey?: string
}

/** The provider each route reaches (providerDefinitions.ts). */
const routeProviders: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  "openai": "openai",
  openrouter: "openrouter",
  deepseek: "deepseek"
}

export const liveChat = (
  api: Api,
  recorder: { url: string; exchanges: Array<Exchange> },
  dataDir: string,
  options: LiveChatOptions
) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const me = yield* api.Whoami()
    const userId = me.id as UserId
    const nonce = crypto.randomUUID().slice(0, 8)
    // The route reaches that provider itself, so the connection is that provider's
    // (OpenAI's prompt_cache_key and cache contract included), not a custom server's.
    const provider = routeProviders[options.route.split("/")[0]!]
    const connection = yield* api.CreateConnection({
      ...(provider ? { provider } : {}),
      kind: options.kind,
      settings: {
        name: `Live ${options.kind}`,
        baseUrl: `${recorder.url}/${options.route}`,
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      },
      apiKey: options.apiKey ?? liveKey()
    })
    // A model the provider lists is used as listed (its catalog price included); otherwise
    // it is added by id, as a user would add one.
    let model: Model | null = null
    if (options.listed) {
      yield* api.RefreshModels({ connectionId: connection.id }).pipe(Effect.ignore)
      const found = (yield* api.ListModels({ connectionId: connection.id, includeHidden: true })).find(
        (m) => m.key === options.listed
      )
      if (found)
        model = yield* api.EditModel({
          modelId: found.id,
          overrides: options.overrides ?? {},
          expectedRowVersion: found.rowVersion
        })
    }
    model ??= yield* api.AddUserModel({
      connectionId: connection.id,
      key: options.model,
      overrides: options.overrides ?? {}
    })
    const stJson = JSON.parse(
      readFileSync(new URL("../../fixtures/presets/default.json", import.meta.url), "utf8")
    ) as Record<string, unknown>
    const stDefault = importStPreset(JSON.stringify(options.stPreset ? options.stPreset(stJson) : stJson)).document!
    const presetDoc = {
      ...stDefault,
      ...options.preset,
      ...(options.prefill === undefined ? {} : { prefill: { ...stDefault.prefill, assistant: options.prefill } }),
      samplers: {
        ...stDefault.samplers,
        openai_max_tokens: 160,
        ...(options.preset?.samplers as object | undefined)
      }
    }
    const entity = (kind: "card" | "preset", label: string, doc: object) =>
      writer.CreateEntity({
        userId,
        kind,
        label,
        subtitle: "",
        doc: doc as never,
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
    const card = (name: string, seed: number) =>
      entity(
        "card",
        name,
        cardDoc(name, {
          description: `{{char}} is a keeper in the harbor town where {{user}} draws maps. ${lore(`${nonce}-${name}`, options.cardTokens, seed)}`,
          personality: `${name} is patient and precise.`,
          scenario: "A quiet evening in the harbor town's archive.",
          ...options.cardFields
        })
      )
    const mira = yield* card("Mira", 1)
    const tobin = yield* entity("card", "Tobin", cardDoc("Tobin", { description: "{{user}} draws maps of the coast." }))
    const preset = yield* entity("preset", "Live preset", presetDoc)
    // The model and preset are the account's (a chat binds none), so each generation, and
    // each estimate, selects this chat's again: a test may interleave several chats.
    const select = api.SetGenerationDefaults({
      defaults: { model: { connection: connection.id, model: model.id }, preset: preset.ref.id }
    })
    yield* select
    const others: Array<EntityId> = []
    const chat: Chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: `Live ${options.kind} ${nonce}`,
      participants: [mira.entityId as EntityId],
      greeting:
        options.greeting === null
          ? null
          : new NewVersion({
              speakerEntityId: mira.entityId as EntityId,
              writer: "model",
              content: options.greeting ?? "*{{char}} looks up from the ledger.* You're late, {{user}}.",
              frozenMacros: {},
              status: "complete",
              macroMode: "template",
              origin: "greeting"
            })
    })
    const state = (data: StateEventData) =>
      writer.AddStateEvent({ userId, chatId: chat.id, slotId: null, versionId: null, scope: null, data })
    yield* state({ key: "played_by_me.set", value: { entities: [tobin.entityId as EntityId] } })
    let seed = 2
    for (const name of options.characters ?? []) {
      const c = yield* card(name, seed++)
      yield* state({ key: "participant.join", value: { entity: c.entityId as EntityId } })
      others.push(c.entityId as EntityId)
    }
    for (const data of options.state ?? []) yield* state(data)
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)

    let leaf: SlotId | null = chat.activeLeafSlotId
    const next = (leafSlotId: SlotId | null = null) => api.GetNextContext({ chatId: chat.id, leafSlotId })
    const settle = (versionId: VersionId, from: number, before: NextContext | null) =>
      Effect.gen(function* () {
        yield* eventually(() => finished(events, versionId) !== undefined)
        const version = finished(events, versionId)!
        // The ledger row closes as the version finishes; give the worker a moment.
        let rows: ReadonlyArray<LlmRequest> = []
        for (let i = 0; i < 100; i++) {
          rows = (yield* api.ListLlmRequests({ limit: 200, before: null }))
            .filter((r) => r.versionId === versionId)
            .reverse()
          if (rows.length > 0 && rows.every((r) => r.status !== "running")) break
          yield* Effect.sleep(100)
        }
        const run = yield* api.GetRunContext({ versionId }).pipe(Effect.orElseSucceed(() => null))
        const exchanges = recorder.exchanges.slice(from).filter((e) => !e.path.endsWith("/models"))
        return {
          version,
          rows,
          row: rows.at(-1),
          stored: storedRequests(dataDir, versionId),
          exchanges,
          exchange: exchanges.at(-1),
          before,
          run
        } satisfies Turn
      })

    /** The user's message, then a reply (by `speaker`, when given). */
    const say = (
      content: string,
      options: {
        readonly speaker?: EntityId
        readonly images?: ReadonlyArray<{ mediaId: string }>
        readonly reply?: boolean
      } = {}
    ) =>
      Effect.gen(function* () {
        const sent = yield* posted(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: leaf,
            branch: false,
            content,
            ...(options.images ? { images: options.images } : {})
          })
        )
        leaf = sent.entry.slotId
        if (options.reply === false) return null
        return yield* reply({ ...(options.speaker ? { speaker: options.speaker } : {}) })
      })

    /** A reply at the leaf without a new user message. */
    const reply = (options: { readonly speaker?: EntityId } = {}) =>
      Effect.gen(function* () {
        yield* select
        const before = yield* next().pipe(Effect.orElseSucceed(() => null))
        const from = recorder.exchanges.length
        const { entry } = yield* posted(
          api.Generate({
            chatId: chat.id,
            parentSlotId: leaf,
            branch: false,
            ...(options.speaker ? { speakerEntityId: options.speaker } : {})
          })
        )
        leaf = entry.slotId
        return yield* settle(entry.version.id, from, before)
      })

    const path = () =>
      api
        .ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 200 })
        .pipe(Effect.map((p) => p.entries))

    /** Another version of the last reply, with the estimate for that request (at its parent). */
    const swipe = Effect.gen(function* () {
      yield* select
      const entries = yield* path()
      const last = entries.at(-1)!
      const parent = entries.at(-2)?.slotId ?? null
      const before = yield* next(parent as SlotId | null).pipe(Effect.orElseSucceed(() => null))
      const shown = yield* next().pipe(Effect.orElseSucceed(() => null))
      const from = recorder.exchanges.length
      const made = yield* api.Regenerate({ slotId: last.slotId, expectedRowVersion: last.rowVersion })
      const turn = yield* settle(made.version.id, from, before)
      return { ...turn, shown }
    })

    /** Edits the message at `index` of the path (0: the greeting). */
    const edit = (index: number, content: string) =>
      Effect.gen(function* () {
        const entries = yield* path()
        const target = entries[index]!
        yield* api.EditVersion({
          slotId: target.slotId,
          sourceVersionId: target.version.id,
          content,
          expectedRowVersion: target.rowVersion
        })
      })

    /** Continues the last reply. */
    const continueLast = Effect.gen(function* () {
      yield* select
      const entries = yield* path()
      const last = entries.at(-1)!
      const before = yield* next().pipe(Effect.orElseSucceed(() => null))
      const from = recorder.exchanges.length
      const made = yield* api.ContinueVersion({ versionId: last.version.id, expectedRowVersion: last.rowVersion })
      return yield* settle(made.version.id, from, before)
    })

    /** Starts a reply and stops it after `chars` characters of text have streamed. */
    const stopAfter = (content: string, chars: number) =>
      Effect.gen(function* () {
        yield* select
        const sent = yield* posted(api.SendMessage({ chatId: chat.id, parentSlotId: leaf, branch: false, content }))
        leaf = sent.entry.slotId
        const from = recorder.exchanges.length
        const { entry } = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: leaf, branch: false }))
        leaf = entry.slotId
        const streamed = () =>
          events
            .filter((e) => e._tag === "Delta" && e.versionId === entry.version.id)
            .reduce((n, e) => n + (e._tag === "Delta" ? e.text.length : 0), 0)
        yield* eventually(() => streamed() >= chars || finished(events, entry.version.id) !== undefined)
        const stoppedAt = streamed()
        yield* api.StopGeneration({ versionId: entry.version.id })
        const turn = yield* settle(entry.version.id, from, null)
        return { ...turn, stoppedAt }
      })

    const upload = (bytes: Uint8Array) =>
      Effect.gen(function* () {
        const port = yield* serverPort
        const response = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${port}/chat/image`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: bytes
          })
        )
        return (yield* Effect.promise(() => response.json())) as { mediaId: string }
      })

    return {
      userId,
      nonce,
      chat,
      connection,
      model,
      preset,
      mira,
      tobin,
      others,
      events,
      writer,
      state,
      next,
      say,
      reply,
      swipe,
      edit,
      path,
      continueLast,
      stopAfter,
      upload
    }
  })
export type LiveChat = Effect.Success<ReturnType<typeof liveChat>>

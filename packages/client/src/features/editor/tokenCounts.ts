// Token counts as the editors show them (owner, 2026-11-02: "ideally you'd always use the
// tokenizer of the selected model"): the server counts with the tokenizer of the model chats
// generate with (`CountTokens`, ARCHITECTURE §6 "Text tokens"), off its main thread, and says
// which tokenizer counted. Typing stays responsive: a field is counted once it has rested for
// DELAY_MS, the counts every field on the page wants then go in one request, and each text is
// counted once per model (cached here and on the server). Until a count comes, the last one
// stays shown.
import { useAtomValue } from "@effect/atom-react"
import { COUNT_TOKENS_CHARS, COUNT_TOKENS_TEXTS, type TokenizerInfo } from "@dreamspan/shared/generation.ts"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useId, useState, useSyncExternalStore } from "react"
import type { ModelChoice } from "@dreamspan/shared/lcmSettings.ts"
import { AppClient } from "../../rpc.ts"
import { defaultsAtom } from "../pickers/defaults.ts"
import { type Caller, useCaller } from "./caller.ts"

/** How long a field rests before it's counted again. */
const DELAY_MS = 400
/** Gathers the requests of every field that rested together into one. */
const GATHER_MS = 20
const CACHE_ENTRIES = 2_000

let calibrationVersion = 0
export const refreshTokenCounts = () => {
  cache.clear()
  tokenizers.clear()
  calibrationVersion++
  changed()
}
const cache = new Map<string, number>()
const tokenizers = new Map<string, TokenizerInfo>()
const inFlight = new Set<string>()
/** A chat's own model, which counts instead of the account's (a message edited in that chat). */
export type CountModel = typeof ModelChoice.Type
let wanted: Array<{
  readonly model: string
  readonly text: string
  readonly choice: CountModel | undefined
  readonly localOnly: boolean
}> = []
let timer: ReturnType<typeof setTimeout> | null = null
let version = 0
const listeners = new Set<() => void>()
/** Each counter's last complete counts, by its `useId`, shown while newer ones are counted. */
const lastShown = new Map<string, ReadonlyArray<number | null>>()

const key = (model: string, text: string) => `${model}\n${text}`

const remember = (k: string, count: number) => {
  cache.delete(k)
  cache.set(k, count)
  if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
}

const changed = () => {
  version++
  for (const listener of listeners) listener()
}

/** A text too long for one request is counted as its estimate: it's past any context anyway. */
const estimate = (text: string) => Math.ceil(text.length / 4)

async function send(call: Caller) {
  timer = null
  const epoch = calibrationVersion
  const batch = wanted
  wanted = []
  // One request per model counting: the account's, and each chat's own.
  const byModel = Map.groupBy(batch, (w) => w.model)
  for (const group of byModel.values())
    for (let at = 0; at < group.length; at += COUNT_TOKENS_TEXTS) {
      const part = group.slice(at, at + COUNT_TOKENS_TEXTS)
      const choice = part[0]!.choice
      const result = await call((client) =>
        client("CountTokens", {
          texts: part.map((w) => w.text),
          ...(choice ? { model: choice } : {}),
          ...(part[0]!.localOnly ? { localOnly: true } : {})
        })
      )
      for (const [i, w] of part.entries()) {
        inFlight.delete(key(w.model, w.text))
        if (result.ok && epoch === calibrationVersion) remember(key(w.model, w.text), result.value.counts[i] ?? 0)
      }
      if (result.ok && epoch === calibrationVersion) tokenizers.set(part[0]!.model, result.value.tokenizer)
    }
  if (epoch !== calibrationVersion) {
    for (const w of batch) requestCounts(call, w.model, [w.text], w.choice, w.localOnly)
  }
  changed()
}

/** Asks for the texts not counted for `model` (the cache's key; `choice`, a chat's own model) yet. */
export function requestCounts(
  call: Caller,
  model: string,
  texts: ReadonlyArray<string>,
  choice: CountModel | undefined = undefined,
  localOnly = false
) {
  let added = false
  for (const text of texts) {
    const k = key(model, text)
    if (text === "" || cache.has(k) || inFlight.has(k)) continue
    if (text.length > COUNT_TOKENS_CHARS) {
      remember(k, estimate(text))
      continue
    }
    inFlight.add(k)
    wanted.push({ model, text, choice, localOnly })
    added = true
  }
  if (added && timer === null) timer = setTimeout(() => void send(call), GATHER_MS)
  else if (!added && texts.some((text) => text.length > COUNT_TOKENS_CHARS)) changed()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** How each connection counts (`GetTokenCounting`): counts by each way are cached apart. */
const countingAtom = AppClient.query("GetTokenCounting", undefined, { reactivityKeys: ["settings"] })

/**
 * The model that counts (`given`, a chat's own, else the account's), and which connection counts
 * for it, as the cache's key: counts follow both.
 */
const useModelKey = (given: CountModel | undefined, localOnly: boolean) => {
  const defaults = useAtomValue(defaultsAtom)
  const counting = useAtomValue(countingAtom)
  const model = given ?? (AsyncResult.isSuccess(defaults) ? defaults.value.model : null)
  if (model === null) return localOnly ? "none/local-only" : "none"
  if (localOnly) return `${model.connection}/${model.model}/local-only`
  const via = AsyncResult.isSuccess(counting)
    ? counting.value.find((choice) => choice.connectionId === model.connection)?.via
    : undefined
  return `${model.connection}/${model.model}/${via ?? "local"}`
}

export interface TokenCounts {
  /** Each text's tokens; null until its first count comes. */
  readonly counts: ReadonlyArray<number | null>
  /** What counted the texts last, for the explanation; null before the first count. */
  readonly tokenizer: TokenizerInfo | null
  /** Shown counts are of an earlier text, or not in yet. */
  readonly pending: boolean
}

/**
 * `texts`' token counts, counted once they rest (see the top of this file). `chatModel`: in a
 * chat with its own model, that model counts (the one its next reply uses); else the account's.
 */
export function useTokenCounts(texts: ReadonlyArray<string>, chatModel?: CountModel, localOnly = false): TokenCounts {
  const call = useCaller()
  const model = useModelKey(chatModel, localOnly)
  const joined = texts.join("\u0000")
  const id = useId()
  const [rested, setRested] = useState(texts)
  useSyncExternalStore(subscribe, () => version)
  useEffect(() => {
    const wait = setTimeout(() => setRested(texts), DELAY_MS)
    return () => clearTimeout(wait)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the texts, by value
  }, [joined])
  const restedJoined = rested.join("\u0000")
  useEffect(() => {
    requestCounts(call, model, rested, chatModel, localOnly)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the rested texts, by value
  }, [call, model, restedJoined, calibrationVersion])
  const counted = rested.map((text) => (text === "" ? 0 : (cache.get(key(model, text)) ?? null)))
  // Keep the last counts on screen while new ones are on their way.
  const counts = counted.map((count, i) => count ?? lastShown.get(id)?.[i] ?? null)
  const settled = counted.every((count) => count !== null)
  const countedJoined = counted.join()
  useEffect(() => {
    if (settled) lastShown.set(id, counted)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the counts, by value
  }, [id, settled, countedJoined])
  useEffect(() => () => void lastShown.delete(id), [id])
  return {
    counts: rested.length === texts.length ? counts : texts.map(() => null),
    tokenizer: tokenizers.get(model) ?? null,
    pending: !settled || restedJoined !== joined
  }
}

/** "~1,234 tokens" while it's approximate or on its way, "1,234 tokens" once exact. */
export const tokensText = (count: number | null, tokenizer: TokenizerInfo | null, pending = false) =>
  count === null ? "… tokens" : `${tokenizer?.exact && !pending ? "" : "~"}${count.toLocaleString()} tokens`

/** What the count's explanation says counted it. */
export const tokenizerText = (tokenizer: TokenizerInfo | null) =>
  tokenizer === null
    ? "Counting with the chat model's tokenizer…"
    : tokenizer.exact
      ? `Counted with ${tokenizer.label}, the model chats use.`
      : `Approximate: counted with ${tokenizer.label}.${tokenizer.note ? ` ${tokenizer.note}` : ""}`

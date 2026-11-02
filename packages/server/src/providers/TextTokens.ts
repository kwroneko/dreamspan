// Token counts for what the editors show (ARCHITECTURE §6 "Text tokens"): with the tokenizer of
// the model the user's chats generate with (their generation default; a chat binds no other),
// through the registered text counters, else o200k_base as an approximation, saying which. A
// provider's counting endpoint is asked only for a connection the user opted in (owner,
// 2026-11-02: the text would go to that provider; `db/tokenCounting.ts`). Counts are
// cached per model and text, so typing re-counts only the field typed in. Never part of a send:
// the context budget keeps the assembler's estimate (§15 "Token counts").
import { createHash } from "node:crypto"
import type { UserId } from "@rp/shared/domain.ts"
import { TokenizerInfo } from "@rp/shared/generation.ts"
import { Context, Effect, Layer, Option, Semaphore } from "effect"
import { Reader } from "../db/Database.ts"
import { Formats } from "../importer/Formats.ts"
import { Providers } from "./Providers.ts"
import { encodingLabel, TokenCountError } from "./textCounters.ts"

/** How long a model whose count failed is counted approximately before it's asked again. */
const RETRY_MS = 10 * 60_000
const CACHE_ENTRIES = 5_000
/** A provider's count past this falls back for this request. */
const REMOTE_TIMEOUT = "15 seconds"

export class TextTokens extends Context.Service<
  TextTokens,
  {
    readonly count: (
      userId: UserId,
      texts: ReadonlyArray<string>
    ) => Effect.Effect<{ readonly counts: ReadonlyArray<number>; readonly tokenizer: TokenizerInfo }>
  }
>()("rp/providers/TextTokens") {
  static readonly layer = Layer.effect(
    TextTokens,
    Effect.gen(function* () {
      const providers = yield* Providers
      const reader = yield* Reader
      const formats = yield* Formats
      const cache = new Map<string, number>()
      const resting = new Map<string, number>()
      /** What counted for each model last, for counts answered from the cache. */
      const lastCounter = new Map<string, { readonly id: string; readonly label: string }>()
      // The providers' endpoints have rate limits of their own: two counts at once, at most.
      const remote = yield* Semaphore.make(2)
      const hash = (text: string) => createHash("sha256").update(text).digest("base64url")
      const remember = (key: string, count: number) => {
        cache.delete(key)
        cache.set(key, count)
        if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
      }
      const encode = (encoding: Parameters<(typeof formats)["countTokens"]>[0], texts: ReadonlyArray<string>) =>
        formats
          .countTokens(encoding, texts)
          .pipe(Effect.mapError(() => new TokenCountError({ message: "the tokenizer worker failed" })))

      /** o200k_base, else the app's estimate: what counts when the model's own tokenizer can't. */
      const approximate = (texts: ReadonlyArray<string>, note: string) =>
        encode("o200k_base", texts).pipe(
          Effect.map((counts) => ({
            counts,
            tokenizer: new TokenizerInfo({
              id: "approximate",
              label: `${encodingLabel("o200k_base")}, as an approximation`,
              exact: false,
              note
            })
          })),
          Effect.orElseSucceed(() => ({
            counts: texts.map((text) => Math.ceil(text.length / 4)),
            tokenizer: new TokenizerInfo({
              id: "estimate",
              label: "the app's estimate, four characters a token",
              exact: false,
              note: `${note} The tokenizer couldn't run either.`
            })
          }))
        )

      /** The model chats generate with, by its connection and its key; none when there's no default. */
      const chosenModel = (userId: UserId) =>
        Effect.gen(function* () {
          const defaults = yield* reader.GetGenerationDefaults({ userId })
          if (defaults.model === null) return Option.none()
          const model = yield* reader.GetModel({ userId, modelId: defaults.model.model })
          const optedIn = (yield* reader.GetTokenCounting({ userId })).includes(defaults.model.connection)
          return Option.some({ connectionId: defaults.model.connection, modelKey: model.key, optedIn })
        }).pipe(Effect.orElseSucceed(() => Option.none()))

      return TextTokens.of({
        count: (userId, texts) =>
          Effect.gen(function* () {
            const chosen = yield* chosenModel(userId)
            if (Option.isNone(chosen))
              return yield* approximate(texts, "No model is chosen for chats, so there's no model's tokenizer to use.")
            const { connectionId, modelKey, optedIn } = chosen.value
            // Counts by the provider and by a local encoding are cached apart.
            const model = `${userId}\n${connectionId}\n${modelKey}\n${optedIn ? "provider" : "local"}`
            if ((resting.get(model) ?? 0) > Date.now())
              return yield* approximate(texts, `Counting with ${modelKey}'s tokenizer failed a moment ago.`)
            const keys = texts.map((text) => `${model}\n${hash(text)}`)
            const missing = [...new Set(texts.filter((_, i) => !cache.has(keys[i]!)))]
            const counted = yield* providers
              .countTextTokens({ userId, connectionId, modelKey, texts: missing, encode, remote: optedIn })
              .pipe(
                (effect) => (missing.length === 0 ? Effect.succeed(null) : effect),
                Effect.timeout(REMOTE_TIMEOUT),
                remote.withPermits(1),
                Effect.map((result) => ({ ok: true as const, result })),
                Effect.catch((error) =>
                  Effect.as(Effect.logWarning(`counting tokens for ${modelKey} failed`, error), {
                    ok: false as const,
                    message: error._tag === "TimeoutError" ? "it took too long." : error.message
                  })
                )
              )
            if (!counted.ok) {
              resting.set(model, Date.now() + RETRY_MS)
              return yield* approximate(texts, `Counting with ${modelKey}'s tokenizer failed: ${counted.message}`)
            }
            if (counted.result === null && missing.length > 0)
              return yield* approximate(texts, `There's no tokenizer for ${modelKey} here.`)
            if (counted.result !== null && "optIn" in counted.result)
              return yield* approximate(
                texts,
                `${modelKey}'s own count (${counted.result.optIn}) is off for this connection, since it sends the text to the provider; its settings can turn it on.`
              )
            if (counted.result) {
              for (const [i, text] of missing.entries()) remember(`${model}\n${hash(text)}`, counted.result.counts[i]!)
              lastCounter.set(model, { id: counted.result.id, label: counted.result.label })
            }
            const counter = lastCounter.get(model)
            return {
              counts: keys.map((key) => cache.get(key) ?? 0),
              tokenizer: new TokenizerInfo({
                id: counter?.id ?? "model",
                label: counter?.label ?? `${modelKey}'s own tokenizer`,
                exact: true
              })
            }
          })
      })
    })
  )
}

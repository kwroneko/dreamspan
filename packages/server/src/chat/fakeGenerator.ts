// A generator that streams synthetic Markdown at a set rate, for tests, the development
// server and the performance harness (CLIENT-FRAMEWORK §7). main.ts refuses it in production.
import { Effect, Layer, Option, Stream } from "effect"
import { Generator } from "./Generator.ts"
import { seedOf, syntheticMarkdown, tokenize } from "./syntheticText.ts"

export interface FakeGeneratorOptions {
  readonly tokensPerSecond: number
  /** About how many tokens each generation has. */
  readonly tokens: number
}

/**
 * Wakes at most every 10 ms and sends the tokens due by then, as a provider's chunks
 * would arrive: 300 tok/s comes as about three tokens per chunk.
 */
export const layer = (options: FakeGeneratorOptions) =>
  Layer.succeed(Generator)(
    Option.some({
      generate: (request) =>
        Stream.suspend(() => {
          const tokens = tokenize(syntheticMarkdown(seedOf(request.versionId), options.tokens))
          const interval = Math.min(100, Math.max(10, 1000 / options.tokensPerSecond))
          const started = Date.now()
          let sent = 0
          return Stream.tick(interval).pipe(
            Stream.mapEffect(() =>
              Effect.sync(() => {
                const due = Math.min(
                  tokens.length,
                  Math.ceil(((Date.now() - started) / 1000) * options.tokensPerSecond)
                )
                const chunk = tokens.slice(sent, due).join("")
                sent = Math.max(sent, due)
                return chunk
              })
            ),
            Stream.takeUntil(() => sent >= tokens.length),
            Stream.filter((chunk) => chunk.length > 0)
          )
        })
    })
  )

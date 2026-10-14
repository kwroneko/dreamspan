// A generator that streams synthetic Markdown at a set rate, for tests, the development
// server and the performance harness (CLIENT-FRAMEWORK §7). Only dev/main.ts and tests wire
// it; the production image doesn't contain it (.dockerignore).
import { Effect, Layer, Option, Stream } from "effect"
import { type GenerationChunk, Generator } from "../chat/Generator.ts"
import { seedOf, syntheticMarkdown, syntheticReasoning, tokenize } from "./syntheticText.ts"

export interface FakeGeneratorOptions {
  readonly tokensPerSecond: number
  /** About how many tokens each generation has. */
  readonly tokens: number
  /** Bursty: the tokens due come all at once this often, at the same average rate. */
  readonly burstMs?: number | undefined
  /** About how many tokens of reasoning come before the text, as a reasoning model's would; none when unset. */
  readonly reasoningTokens?: number | undefined
}

/**
 * Wakes at most every 10 ms and sends the tokens due by then, as a provider's chunks
 * would arrive: 300 tok/s comes as about three tokens per chunk. Bursty, it wakes every
 * `burstMs` instead. With `reasoningTokens`, reasoning streams first, at the same rate.
 */
export const layer = (options: FakeGeneratorOptions) =>
  Layer.succeed(Generator)(
    Option.some({
      generate: (request) =>
        Stream.suspend(() => {
          const seed = seedOf(request.versionId)
          const reasoning: ReadonlyArray<GenerationChunk> = options.reasoningTokens
            ? tokenize(syntheticReasoning(seed, options.reasoningTokens)).map((token) => ({ reasoning: token }))
            : []
          const tokens: ReadonlyArray<GenerationChunk> = [
            ...reasoning,
            ...tokenize(syntheticMarkdown(seed, options.tokens))
          ]
          const interval = options.burstMs ?? Math.min(100, Math.max(10, 1000 / options.tokensPerSecond))
          const started = Date.now()
          let sent = 0
          return Stream.tick(interval).pipe(
            Stream.mapEffect(() =>
              Effect.sync(() => {
                const due = Math.min(
                  tokens.length,
                  Math.ceil(((Date.now() - started) / 1000) * options.tokensPerSecond)
                )
                const chunk = tokens.slice(sent, due)
                sent = Math.max(sent, due)
                return joined(chunk)
              })
            ),
            Stream.takeUntil(() => sent >= tokens.length),
            Stream.flatMap((chunks) => Stream.fromIterable(chunks))
          )
        })
    })
  )

/** The tokens due, as one text chunk and one reasoning chunk (a provider's chunk carries either). */
const joined = (chunk: ReadonlyArray<GenerationChunk>): ReadonlyArray<GenerationChunk> => {
  const text = chunk.filter((c) => typeof c === "string").join("")
  const reasoning = chunk.flatMap((c) => (typeof c === "string" ? [] : [c.reasoning])).join("")
  return [...(reasoning ? [{ reasoning }] : []), ...(text ? [text] : [])]
}

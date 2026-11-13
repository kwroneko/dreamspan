// A generator that streams synthetic Markdown at a set rate, for tests, the development
// server and the performance harness (CLIENT-FRAMEWORK §7). Only dev/main.ts and tests wire
// it; the production image doesn't contain it (.dockerignore).
import { Effect, Layer, Option, Stream } from "effect"
import { type GenerationChunk, Generator } from "../chat/Generator.ts"
import { DEFAULT_REPLY_SECTIONS } from "@rp/shared/replySections.ts"
import { compilePairs, parseReply, throughParse } from "../chat/replySections.ts"
import { seedOf, syntheticMarkdown, syntheticReasoning, tokenize } from "./syntheticText.ts"

export interface FakeGeneratorOptions {
  readonly tokensPerSecond: number
  /** About how many tokens each generation has. */
  readonly tokens: number
  /** Fixed prose for fixtures; absent, each version gets its own stable seed. */
  readonly seed?: number | undefined
  /** Bursty: the tokens due come all at once this often, at the same average rate. */
  readonly burstMs?: number | undefined
  /** About how many tokens of reasoning come before the text, as a reasoning model's would; none when unset. */
  readonly reasoningTokens?: number | undefined
  /**
   * About how many tokens of a tagged section the text starts with, in `<thinking>` /
   * `</thinking>`, both tags split across two chunks; none when unset.
   */
  readonly sectionTokens?: number | undefined
  /**
   * About how many tokens of a chain of thought the body starts with, in `<cot>` / `</cot>`
   * split across chunks, for a regex script to strip; none when unset.
   */
  readonly cotTokens?: number | undefined
}

/**
 * Wakes at most every 10 ms and sends the tokens due by then, as a provider's chunks
 * would arrive: 300 tok/s comes as about three tokens per chunk. Bursty, it wakes every
 * `burstMs` instead. With `reasoningTokens`, reasoning streams first, at the same rate.
 * Its text goes through the reply-section parser with the default tags, as a preset's would.
 */
export const layer = (options: FakeGeneratorOptions) =>
  Layer.succeed(Generator)(
    Option.some({
      kind: "fake",
      generate: (request) =>
        Stream.suspend(() => {
          const seed = options.seed ?? seedOf(request.versionId)
          const reasoning: ReadonlyArray<GenerationChunk> = options.reasoningTokens
            ? tokenize(syntheticReasoning(seed, options.reasoningTokens)).map((token) => ({ reasoning: token }))
            : []
          const section: ReadonlyArray<GenerationChunk> = options.sectionTokens
            ? [
                "<thin",
                "king>\n",
                ...tokenize(syntheticReasoning(seed + 1, options.sectionTokens)),
                "\n</thin",
                "king>\n\n"
              ]
            : []
          const cot: ReadonlyArray<GenerationChunk> = options.cotTokens
            ? ["<c", "ot>", ...tokenize(syntheticReasoning(seed + 2, options.cotTokens)), "</c", "ot>\n"]
            : []
          const tokens: ReadonlyArray<GenerationChunk> = [
            ...reasoning,
            ...section,
            ...cot,
            ...tokenize(syntheticMarkdown(seed, options.tokens))
          ]
          const interval = options.burstMs ?? Math.min(100, Math.max(10, 1000 / options.tokensPerSecond))
          const started = Date.now()
          let sent = 0
          const parse = parseReply(compilePairs(DEFAULT_REPLY_SECTIONS), request.initial, null)
          const stream = Stream.tick(interval).pipe(
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
          return throughParse(stream, parse)
        })
    })
  )

/** The tokens due, as one text chunk and one reasoning chunk (a provider's chunk carries either). */
const joined = (chunk: ReadonlyArray<GenerationChunk>): ReadonlyArray<GenerationChunk> => {
  const text = chunk.filter((c) => typeof c === "string").join("")
  const reasoning = chunk.flatMap((c) => (typeof c !== "string" && "reasoning" in c ? [c.reasoning] : [])).join("")
  return [...(reasoning ? [{ reasoning }] : []), ...(text ? [text] : [])]
}

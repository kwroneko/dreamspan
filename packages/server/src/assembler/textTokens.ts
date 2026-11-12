// Prepared in the reader worker, never by contacting a provider. Memoize repeated fragments
// within one assembly so binary budget probes do not tokenize the same history repeatedly.
import { Effect } from "effect"
import { prepareTokenizer } from "../importer/tokenizer.ts"
import type { TextTokenCounter } from "../providers/textCounters.ts"
import { estimateTokens } from "./st.ts"
import type { ModelInput } from "./types.ts"

export const prepareTextTokens = Effect.fnUntraced(function* (
  counters: ReadonlyArray<TextTokenCounter>,
  model: ModelInput | null
) {
  const target = { kind: model?.kind ?? "", api: model?.api ?? "", model: model?.key ?? "", baseUrl: "" }
  const counter = counters.toReversed().find((c) => !c.remote && c.prepare && c.appliesTo(target))
  const count = yield* Effect.tryPromise(() =>
    counter?.prepare ? counter.prepare(target.model) : prepareTokenizer("o200k_base")
  ).pipe(Effect.orElseSucceed(() => estimateTokens))
  const cache = new Map<string, number>()
  let characters = 0
  return (text: string): number => {
    const found = cache.get(text)
    if (found !== undefined) return found
    let tokens: number
    try {
      tokens = count(text)
    } catch {
      tokens = estimateTokens(text)
    }
    // Bound retained text even for very large imported chats.
    if (characters + text.length <= 4_000_000 && cache.size < 20_000) {
      cache.set(text, tokens)
      characters += text.length
    }
    return tokens
  }
})

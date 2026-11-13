import { Tokenizer } from "@huggingface/tokenizers"
// Local text tokenizers, run in the format workers' interactive lane (ARCHITECTURE §6 "Text
// tokens"): OpenAI's BPE encodings through tiktoken's Wasm binding. An encoding's ranks
// load on the worker's first count and stay there. The Wasm binding keeps large unbroken
// words responsive; the old pure-JS binding took 46 s for 20,000 repeated characters.
import type { Tiktoken } from "tiktoken"

export const LOCAL_ENCODINGS = [
  "o200k_base",
  "cl100k_base",
  "llama3",
  "mistral-v3",
  "qwen2",
  "qwen3",
  "deepseek-v3",
  "deepseek-v4",
  "deepseek-api",
  "gemma2"
] as const
export type LocalEncoding = (typeof LOCAL_ENCODINGS)[number]

const encoders = new Map<LocalEncoding, Promise<Tiktoken>>()

const load = async (encoding: LocalEncoding): Promise<Tiktoken> => {
  const { get_encoding } = await import("tiktoken")
  return get_encoding(encoding === "o200k_base" ? "o200k_base" : "cl100k_base")
}

const encoder = (encoding: LocalEncoding) => {
  let found = encoders.get(encoding)
  if (!found) {
    found = load(encoding)
    // A failed load is tried again next time.
    found.catch(() => encoders.delete(encoding))
    encoders.set(encoding, found)
  }
  return found
}

/** Bound individual BPE runs, including words and combining marks, as well as whitespace.
 * Long runs can otherwise monopolize a reader for minutes. Splitting is an approximation:
 * boundary merges can change the count, never the input text or provider request bytes.
 */
const RUN_PIECE = 4096

export const segmentedTokenCount = (texts: ReadonlyArray<string>) =>
  texts.some((text) => {
    if (text.length < RUN_PIECE) return false
    for (const match of text.matchAll(/\s+|\S+/gu)) if (match[0].length >= RUN_PIECE) return true
    return false
  })

const runsInPieces =
  (count: (text: string) => number) =>
  (text: string): number => {
    let total = 0
    let start = 0
    // A bounded per-call memo also keeps multi-megabyte repeated text cheap.
    const pieces = new Map<string, number>()
    for (const match of text.matchAll(/\s+|\S+/gu)) {
      if (match[0].length < RUN_PIECE) continue
      const at = match.index
      total += count(text.slice(start, at))
      const end = at + match[0].length
      for (let pos = at; pos < end;) {
        let next = Math.min(pos + RUN_PIECE, end)
        // Never cut a UTF-16 pair in two.
        if (next < end && /[\uD800-\uDBFF]/.test(text[next - 1]!)) next--
        const piece = text.slice(pos, next)
        let tokens = pieces.get(piece)
        if (tokens === undefined) {
          tokens = count(piece)
          if (pieces.size < 32) pieces.set(piece, tokens)
        }
        total += tokens
        pos = next
      }
      start = end
    }
    return total + count(text.slice(start))
  }

/** Each text's token count. Special-token text ("<|endoftext|>") counts as ordinary text. */
export const prepareTokenizer = async (encoding: LocalEncoding): Promise<(text: string) => number> => {
  if (encoding === "llama3") {
    const { default: tokenizer } = await import("llama3-tokenizer-js")
    return runsInPieces((text) => (text === "" ? 0 : tokenizer.encode(text, { bos: false, eos: false }).length))
  }
  if (encoding !== "o200k_base" && encoding !== "cl100k_base") {
    const tokenizer = await hfEncoder(encoding)
    return runsInPieces((text) => (text === "" ? 0 : tokenizer.encode(text, { add_special_tokens: false }).ids.length))
  }
  const tiktoken = await encoder(encoding)
  return runsInPieces((text) => (text === "" ? 0 : tiktoken.encode(text, [], []).length))
}

/** Batch counting and assembly use the same loaded tokenizer. */
export const countTokens = async (encoding: LocalEncoding, texts: ReadonlyArray<string>) =>
  texts.map(await prepareTokenizer(encoding))

// Vendored, revision-pinned files; no download or provider request at runtime.
const hfEncoders = new Map<string, Promise<import("@huggingface/tokenizers").Tokenizer>>()
const hfEncoder = (encoding: string) => {
  let found = hfEncoders.get(encoding)
  if (!found) {
    found = (async () => {
      const [{ readFile }, { gunzipSync }] = await Promise.all([import("node:fs/promises"), import("node:zlib")])
      const bytes = await readFile(new URL(`./tokenizers/${encoding}.json.gz`, import.meta.url))
      return new Tokenizer(JSON.parse(gunzipSync(bytes).toString("utf8")), {})
    })()
    found.catch(() => hfEncoders.delete(encoding))
    // One large HF vocabulary per worker; changing families releases the old instance.
    hfEncoders.clear()
    hfEncoders.set(encoding, found)
  }
  return found
}

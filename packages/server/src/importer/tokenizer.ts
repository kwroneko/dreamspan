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

/**
 * The length a whitespace run is counted in pieces of. Every tokenizer here merges one
 * whitespace run in time quadratic in its length (tiktoken took 2.6 s for 65,536 spaces, so
 * about 40 s for a greeting of 262,145); pieces keep it linear. A run that long is a few
 * hundred tokens either way, and pieces change its count by at most one token each.
 */
const RUN_PIECE = 4096
const LONG_RUN = new RegExp(`(\\s{${RUN_PIECE},})`)

/** `count` over a text whose whitespace runs longer than RUN_PIECE are counted in pieces. */
const runsInPieces =
  (count: (text: string) => number) =>
  (text: string): number => {
    if (text.length <= RUN_PIECE) return count(text)
    let total = 0
    text.split(LONG_RUN).forEach((part, index) => {
      if (part === "") return
      // split() puts the captured runs at the odd indexes.
      if (index % 2 === 0) total += count(part)
      else for (let at = 0; at < part.length; at += RUN_PIECE) total += count(part.slice(at, at + RUN_PIECE))
    })
    return total
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

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

/** Each text's token count. Special-token text ("<|endoftext|>") counts as ordinary text. */
export const countTokens = async (encoding: LocalEncoding, texts: ReadonlyArray<string>) => {
  if (encoding === "llama3") {
    const { default: tokenizer } = await import("llama3-tokenizer-js")
    return texts.map((text) => (text === "" ? 0 : tokenizer.encode(text, { bos: false, eos: false }).length))
  }
  if (encoding !== "o200k_base" && encoding !== "cl100k_base") {
    const tokenizer = await hfEncoder(encoding)
    return texts.map((text) => (text === "" ? 0 : tokenizer.encode(text, { add_special_tokens: false }).ids.length))
  }
  const tiktoken = await encoder(encoding)
  return texts.map((text) => (text === "" ? 0 : tiktoken.encode(text, [], []).length))
}

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

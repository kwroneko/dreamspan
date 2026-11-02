// Local text tokenizers, run in the format workers' interactive lane (ARCHITECTURE §6 "Text
// tokens"): OpenAI's BPE encodings through js-tiktoken, pure JavaScript. An encoding's ranks
// take about 70 MB of the worker's heap once loaded, so each is loaded on its first count and
// kept; encoding 20,000 characters takes about 20 ms (measured at a load average near 28).
import type { Tiktoken } from "js-tiktoken/lite"

export const LOCAL_ENCODINGS = ["o200k_base", "cl100k_base"] as const
export type LocalEncoding = (typeof LOCAL_ENCODINGS)[number]

const encoders = new Map<LocalEncoding, Promise<Tiktoken>>()

const load = async (encoding: LocalEncoding): Promise<Tiktoken> => {
  const { Tiktoken } = await import("js-tiktoken/lite")
  const ranks =
    encoding === "o200k_base"
      ? (await import("js-tiktoken/ranks/o200k_base")).default
      : (await import("js-tiktoken/ranks/cl100k_base")).default
  return new Tiktoken(ranks)
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
  const tiktoken = await encoder(encoding)
  return texts.map((text) => (text === "" ? 0 : tiktoken.encode(text, [], []).length))
}

// Conservative model-id mapping: variants with different vocabularies must get their own
// registration. Local GGUF paths and router ids retain the published family/version name.
import type { LocalEncoding } from "../importer/tokenizer.ts"

export const localTextEncoding = (model: string): LocalEncoding | null => {
  const name = model
    .toLowerCase()
    .replace(/^models\//, "")
    .replace(/^openai\//, "")
  if (/^(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|o1|o3|o4|chatgpt-4o|gpt-oss)/.test(name)) return "o200k_base"
  if (/^(gpt-4|gpt-3\.5|gpt-35)/.test(name)) return "cl100k_base"
  // Distill models use their base family's tokenizer, not DeepSeek V3's.
  if (/(?:^|[/_-])(?:llama-?3(?:\.[123])?|llama3(?:\.[123])?)(?:[-_:/]|\.gguf$|$)/.test(name)) return "llama3"
  if (/(?:^|[/_-])qwen3(?:[-_:/]|\.gguf$|$)/.test(name) && !/vl|omni|next/.test(name)) return "qwen3"
  if (/^(?:deepseek\/)?deepseek-flash$/.test(name)) return "deepseek-api"
  if (/(?:^|[/_-])deepseek-v4(?:[-_:/]|\.gguf$|$)/.test(name)) return "deepseek-v4"
  if (/(?:^|[/_-])qwen2(?:\.5)?(?:[-_:/]|\.gguf$|$)/.test(name) && !/vl|omni/.test(name)) return "qwen2"
  if (/(?:^|[/_-])mistral-7b(?:-instruct)?-v0\.3(?:[-_:/]|\.gguf$|$)/.test(name)) return "mistral-v3"
  if (/(?:^|[/_-])gemma-?2(?:[-_:/]|\.gguf$|$)/.test(name)) return "gemma2"
  if (/(?:^|[/_-])deepseek-(?:v3(?:-0324)?|r1(?:-0528)?)(?:[-_:/]|\.gguf$|$)/.test(name) && !name.includes("distill"))
    return "deepseek-v3"
  return null
}

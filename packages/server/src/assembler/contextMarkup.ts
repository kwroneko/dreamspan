// The markup the app wraps a model's context in, in one place: the assembler writes it with these,
// and the reply contract's records (agent/contract.ts) recognize a reply that copies it
// (spec/REPLY-CONTRACT.md §3.6 `context_mimicry`; reference-harness's RENDERED_MESSAGE_TAGS). A test
// keeps the two in step: everything written here is recognized there.

/** A history line with its speaker's name before it (the preset's names behavior). */
export const speakerLabel = (name: string, text: string) => `${name}: ${text}`

/** A card's own block, its text between tags named after it (a note sent on its own turns). */
export const nameBlock = (name: string, text: string) => `<${name}>\n${text}\n</${name}>`

/**
 * The fixed tags the context holds: summaries, quoted tool data and its metadata, and a story
 * excerpt a side chat reads.
 */
export const CONTEXT_TAGS = ["summary", "tool_data", "result_metadata", "story_excerpt"] as const

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const FIXED = new RegExp(`</?(?:${CONTEXT_TAGS.join("|")})(?=[\\s>/])`)

/**
 * Whether `text` holds the context's own markup: one of its fixed tags, a name's block tag, or a
 * line that starts with a name's speaker label. `names`: the names the context used.
 */
export const looksLikeContextMarkup = (text: string, names: ReadonlyArray<string>) => {
  if (FIXED.test(text)) return true
  const named = names.map((n) => n.trim()).filter((n) => n !== "")
  if (named.length === 0) return false
  const alt = named.map(escape).join("|")
  return new RegExp(`</?(?:${alt})>`).test(text) || new RegExp(`(?:^|\\n)[ \\t]*(?:${alt}):[ \\t]`).test(text)
}

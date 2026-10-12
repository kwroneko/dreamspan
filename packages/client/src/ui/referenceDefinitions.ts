// Reference-style links across Markdown blocks (ui/Markdown.tsx). Streamdown renders each
// block on its own, so a link in one can't see a definition in another: a block gets
// copies of the definitions it refers to, at its end, where they render as nothing.

const HAS_DEFINITION = /^ {0,3}\[[^\]]+\]:/m
const DEFINITION = /^ {0,3}\[([^\]]+)\]:.*$/gm
/** Anything in brackets: the text of `[text][label]`, the label, or a shortcut `[label]`. */
const BRACKETED = /\[([^[\]]+)\]/g
/** A line opening or closing a fenced code block. */
const FENCE = /^ {0,3}(?:```|~~~)/gm

/**
 * At most this many characters of definitions are copied into one message's blocks. Text
 * that refers to its definitions from every block (a model's, or a card's) stops getting
 * them past this, rather than growing with the square of its length.
 */
export const MAX_COPIED = 32_768

/** Labels match without regard to case or runs of whitespace (CommonMark). */
const normalize = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase()

/**
 * The blocks, each with the definitions it refers to and doesn't hold itself. Linear in
 * the text, plus at most MAX_COPIED copied. Not inside a code block still open (a
 * streaming one), where they'd show.
 */
export const withDefinitions = (text: string, blocks: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (!HAS_DEFINITION.test(text)) return blocks
  const definitions = new Map<string, string>()
  for (const [line, label] of text.matchAll(DEFINITION)) {
    const key = normalize(label!)
    // The first definition of a label wins.
    if (!definitions.has(key)) definitions.set(key, line)
  }
  let budget = MAX_COPIED
  return blocks.map((block) => {
    if (budget <= 0 || (block.match(FENCE)?.length ?? 0) % 2 === 1) return block
    const own = new Set([...block.matchAll(DEFINITION)].map(([, label]) => normalize(label!)))
    const copied: Array<string> = []
    for (const [, label] of block.matchAll(BRACKETED)) {
      const key = normalize(label!)
      const line = definitions.get(key)
      if (line === undefined || own.has(key) || line.length > budget) continue
      own.add(key)
      copied.push(line)
      budget -= line.length
    }
    return copied.length === 0 ? block : `${block.replace(/\n*$/, "")}\n\n${copied.join("\n")}\n`
  })
}

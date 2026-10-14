// Synthetic roleplay prose in Markdown, made from a seed: the fake generator's output and
// the performance harness's fixtures. Never derived from real chats (CLAUDE.md "Privacy").

/** mulberry32: small, fast and good enough for varied text. */
const random = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NAMES = ["Mira", "Tobin", "Ser Aldric", "Wren", "the ferryman", "Ilse", "Corvin", "the archivist"]
const PLACES = ["the harbor", "the lantern market", "the old chapel", "the north road", "the tide caves"]
const NARRATION = (
  "the rain needled the slate roofs while somewhere below a bell rang twice and stopped " +
  "lantern light pooled on the wet cobbles and the smell of salt and tar hung over everything " +
  "she counted the ships that had not come back and folded the letter along its old creases " +
  "a gull screamed overhead and the crowd parted for a cart loaded with barrels of brine " +
  "he kept his voice low though nobody in the tavern seemed to be listening to anything at all " +
  "the fire had burned down to embers and the shadows in the corners had grown long and patient"
).split(" ")
const SPEECH = (
  "you were never supposed to find that letter " +
  "I told you the tide would turn before midnight and you laughed at me " +
  "if we leave now we can reach the chapel before the watch changes " +
  "nobody crosses the north road after dark not even for that much silver " +
  "keep your hood up and let me do the talking this time"
).split(" ")

const pick = <A>(next: () => number, items: ReadonlyArray<A>) => items[Math.floor(next() * items.length)]!

const words = (next: () => number, source: ReadonlyArray<string>, count: number) => {
  const start = Math.floor(next() * source.length)
  const out: Array<string> = []
  for (let i = 0; i < count; i++) out.push(source[(start + i) % source.length]!)
  return out
}

const sentence = (parts: ReadonlyArray<string>) => {
  const text = parts.join(" ")
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`
}

/** One block of Markdown, about `size` words: mostly prose and dialogue, now and then structure. */
const block = (next: () => number, size: number): string => {
  const kind = next()
  const name = pick(next, NAMES)
  if (kind < 0.55) {
    const action = words(next, NARRATION, Math.max(4, Math.floor(size / 3)))
    const rest = words(next, NARRATION, Math.max(6, size - action.length))
    return `*${name} ${action.join(" ")}.* ${sentence(rest)} The air near ${pick(next, PLACES)} felt **heavier** than before.`
  }
  if (kind < 0.85) {
    const line = words(next, SPEECH, Math.max(5, size - 4))
    return `"${sentence(line).slice(0, -1)}," ${name} said, *glancing toward ${pick(next, PLACES)}*. "${sentence(words(next, SPEECH, 6))}"`
  }
  if (kind < 0.92) {
    const items = 3 + Math.floor(next() * 3)
    const list: Array<string> = []
    for (let i = 0; i < items; i++) list.push(`- ${sentence(words(next, NARRATION, 3 + Math.floor(next() * 6)))}`)
    return `${name} went over what they knew:\n\n${list.join("\n")}`
  }
  if (kind < 0.96) return `> ${sentence(words(next, SPEECH, Math.max(6, size)))}\n> — a note in ${name}'s hand`
  if (kind < 0.98) return `### ${sentence(words(next, NARRATION, 3))}\n\n${sentence(words(next, NARRATION, size))}`
  return `| Ship | Cargo | Due |\n| --- | --- | --- |\n| *Gull* | brine | dawn |\n| *Heron* | tar | ${pick(next, PLACES)} |`
}

/** Markdown of about `wordCount` words, the same for the same seed. */
export const syntheticMarkdown = (seed: number, wordCount: number): string => {
  const next = random(seed)
  const blocks: Array<string> = []
  let total = 0
  while (total < wordCount) {
    const size = Math.min(wordCount - total, 12 + Math.floor(next() * 50))
    const text = block(next, Math.max(4, size))
    blocks.push(text)
    total += text.split(/\s+/).length
  }
  return blocks.join("\n\n")
}

const PLANS = [
  "The scene is at {place}, so I should keep the weather and the light consistent with the last reply.",
  "{name} is wary here; their lines should stay short and guarded.",
  "I shouldn't speak for the user's character, only describe what {name} does and says.",
  "The letter was mentioned earlier, so a callback to it would keep the thread going.",
  "Pacing: one beat of action, then dialogue, then end on something the user can answer.",
  "Check the tone against the card: dry humor, never cruel.",
  "Maybe {name} notices the bell first, since they were listening for it."
]

/** A model's reasoning before it writes, as plain sentences, the same for the same seed. */
export const syntheticReasoning = (seed: number, wordCount: number): string => {
  const next = random(seed ^ 0x5eed)
  const lines: Array<string> = []
  let total = 0
  while (total < wordCount) {
    const line = pick(next, PLANS).replace("{place}", pick(next, PLACES)).replace("{name}", pick(next, NAMES))
    lines.push(line)
    total += line.split(/\s+/).length
  }
  return lines.join(" ")
}

/** Text in streaming tokens, a word with its trailing space each; they join back to the text. */
export const tokenize = (text: string): Array<string> => text.match(/\s*\S+\s*/g) ?? []

/** A seed from an id, so a version's synthetic text is stable. */
export const seedOf = (id: string) => {
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619)
  return hash >>> 0
}

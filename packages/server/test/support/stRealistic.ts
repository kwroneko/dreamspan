// A synthetic SillyTavern data folder shaped like a real one, for walking through the app
// (and later, tests at realistic scale): Chub-style card files, personas, group chats, many
// chats per card titled the way ST titles them, long histories with swipes, a branch, a
// hidden run with a summary, lorebooks, and a selected preset with a large context. Every
// name and text is made up; the shapes follow ST's public source.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { worldInfo } from "../formats/support.ts"
import { card, encode, header, jsonl } from "./stFolder.ts"

/** A small deterministic generator, so the folder is the same every time. */
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}

const SENTENCES = [
  "The rain had not stopped since noon, and the gutters ran like small rivers.",
  "She set the cup down a little too hard, and the saucer rang.",
  "Somewhere below, a door slammed and footsteps hurried away.",
  "He studied the map for a long moment before folding it along the old creases.",
  "The lamp hissed, throwing long shadows across the cluttered desk.",
  "A smile tugged at the corner of her mouth, though her eyes stayed wary.",
  "Nobody spoke; the silence was its own kind of answer.",
  "The engine coughed twice, then settled into a steady, reluctant hum.",
  "Outside, the market was already waking: shutters, voices, the smell of bread.",
  "He leaned against the railing and let the wind take the rest of his words.",
  "There was a scratch on the lock that hadn't been there yesterday.",
  "Her hand found the hilt before she had decided to reach for it.",
  "The letter was unsigned, but the handwriting was unmistakable.",
  "Far off, a bell tolled the hour, and then, oddly, once more.",
  "They counted the coins twice and came up short both times."
]

const prose = (next: () => number, sentences: number) =>
  Array.from({ length: sentences }, () => SENTENCES[Math.floor(next() * SENTENCES.length)]).join(" ")

/** A card as Chub names its download: `main_<slug>-<hash>_spec_v2.png`. */
const chubFile = (name: string, hash: string) =>
  `main_${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${hash}_spec_v2`

interface CardSpec {
  readonly name: string
  readonly hash: string
  readonly role: string
  readonly book?: boolean
}

const CARDS: ReadonlyArray<CardSpec> = [
  { name: "Aria Vance", hash: "3f9a1c2b", role: "a smuggler captain with a debt to the harbor guild", book: true },
  { name: "Karen Holt", hash: "77b2e0aa", role: "a tired detective in a city that never dries out" },
  { name: "Mireille", hash: "c41d9e07", role: "a court mage who distrusts everyone, herself included", book: true },
  { name: "Tobias Wren", hash: "0a6f55d1", role: "an innkeeper who hears every rumor first" },
  { name: "Unit 7", hash: "e2c8a913", role: "a maintenance android that has started keeping a diary" },
  { name: "Lady Corvina", hash: "5b0e7f2c", role: "a widowed duchess hosting a dangerous masquerade" },
  { name: "Juniper", hash: "9d3a40be", role: "a cheerful cartographer who is always slightly lost" },
  { name: "Dr. Ilsa Brandt", hash: "18f6c2d4", role: "the station's chief medical officer, three weeks without sleep" },
  { name: "Rook", hash: "a07b39e5", role: "a mercenary with a strict code and a soft spot for strays" },
  { name: "The Narrator", hash: "66c1d8f0", role: "a scenario narrator for the city of Saltmarsh" },
  { name: "Fen", hash: "2e94b7a1", role: "a river spirit bound to a mill wheel" },
  { name: "Captain Osei", hash: "d5a2e60c", role: "the stern captain of the survey ship Kepler" }
]

const PERSONAS = [
  { file: "sam.png", name: "Sam", description: "Sam is a wandering scribe with ink-stained fingers." },
  { file: "kim.png", name: "Kim", description: "Kim carries a lantern and asks too many questions." },
  { file: "rhee.png", name: "Captain Rhee", description: "Rhee commands the relief ship, newly arrived." }
]

/** ST's chat file name: `<name> - <humanized date>`. */
const stamp = (date: Date) => {
  const p = (n: number, w = 2) => String(n).padStart(w, "0")
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}@${p(date.getUTCHours())}h${p(date.getUTCMinutes())}m${p(date.getUTCSeconds())}s${p(date.getUTCMilliseconds(), 3)}ms`
}

const message = (
  next: () => number,
  input: {
    name: string
    user: boolean
    at: number
    avatar?: string
    persona?: string
    swipes?: number
    hidden?: boolean
    memory?: string
  }
) => {
  const mes = prose(next, input.user ? 1 + Math.floor(next() * 3) : 4 + Math.floor(next() * 8))
  const date = new Date(input.at).toISOString()
  const swipes = input.swipes ? [mes, ...Array.from({ length: input.swipes - 1 }, () => prose(next, 6))] : null
  return {
    name: input.name,
    is_user: input.user,
    is_system: input.hidden ?? false,
    send_date: date,
    mes,
    ...(swipes ? { swipes, swipe_id: 0, swipe_info: swipes.map(() => ({ send_date: date, extra: {} })) } : {}),
    ...(input.avatar
      ? {
          original_avatar: input.avatar,
          force_avatar: `/thumbnail?type=avatar&file=${encodeURIComponent(input.avatar)}`
        }
      : {}),
    ...(input.persona ? { force_avatar: `/thumbnail?type=persona&file=${encodeURIComponent(input.persona)}` } : {}),
    extra: input.memory ? { memory: input.memory } : {}
  }
}

/** A chat between the persona and `speakers`, `count` messages from `start`. */
const chatLines = (
  next: () => number,
  speakers: ReadonlyArray<{ name: string; avatar?: string }>,
  persona: (typeof PERSONAS)[number],
  count: number,
  start: number,
  options: { hiddenRun?: number; group?: boolean } = {}
) => {
  const lines: Array<unknown> = [header({})]
  let at = start
  for (let i = 0; i < count; i++) {
    at += 60_000 + Math.floor(next() * 600_000)
    const user = i % 2 === 1
    const speaker = speakers[Math.floor(next() * speakers.length)]!
    const hidden = options.hiddenRun !== undefined && i < options.hiddenRun
    lines.push(
      message(next, {
        name: user ? persona.name : speaker.name,
        user,
        at,
        ...(user ? { persona: persona.file } : options.group && speaker.avatar ? { avatar: speaker.avatar } : {}),
        ...(!user && next() < 0.15 ? { swipes: 2 + Math.floor(next() * 5) } : {}),
        hidden,
        ...(hidden && i === options.hiddenRun! - 1 ? { memory: prose(next, 10) } : {})
      })
    )
  }
  return lines
}

const presetFile = (base: Record<string, unknown>, name: string, context: number) => ({
  ...base,
  openai_max_context: context,
  openai_max_tokens: 1000,
  temperature: 1,
  name
})

/**
 * Writes the folder under `root` (ST's `data/default-user` layout) and returns that path.
 * `summary` is how ST sent the hidden run's summary: injected at depth 3 (the default), only
 * through `{{summary}}` in the selected preset's main prompt (the Summarize extension on with
 * its position None), or not at all (the extension disabled, the macro still in the preset).
 * Only settings and the preset differ; every count stays the same.
 */
export const writeRealisticStFolder = (
  root: string,
  options: { readonly summary?: "injected" | "macro" | "disabled" } = {}
) => {
  const summary = options.summary ?? "injected"
  const next = rng(20261014)
  const files = new Map<string, Uint8Array>()
  const put = (path: string, bytes: Uint8Array) => files.set(path, bytes)

  const defaultPreset = JSON.parse(
    readFileSync(new URL("../fixtures/presets/default.json", import.meta.url), "utf8")
  ) as Record<string, unknown>
  // The macro variant sends the summary through the selected preset's main prompt.
  const withMacro = (preset: Record<string, unknown>) => ({
    ...preset,
    prompts: (preset.prompts as Array<Record<string, unknown>>).map((p) =>
      p.identifier === "main" ? { ...p, content: `${String(p.content)}\n\n[Story so far: {{summary}}]` } : p
    )
  })
  put(
    "OpenAI Settings/Celia 4.2.json",
    encode(presetFile(summary === "injected" ? defaultPreset : withMacro(defaultPreset), "Celia 4.2", 128_000))
  )
  put("OpenAI Settings/Pixijb v18.json", encode(presetFile(defaultPreset, "Pixijb v18", 64_000)))
  put("OpenAI Settings/Default.json", encode(defaultPreset))
  put("worlds/Saltmarsh.json", encode(worldInfo()))
  put("worlds/Kepler Station.json", encode(worldInfo()))

  put(
    "settings.json",
    encode({
      username: "Sam",
      user_avatar: "sam.png",
      power_user: {
        personas: Object.fromEntries(PERSONAS.map((p) => [p.file, p.name])),
        persona_descriptions: Object.fromEntries(
          PERSONAS.map((p) => [p.file, { description: p.description, position: 0, depth: 2, role: 0 }])
        ),
        default_persona: "sam.png"
      },
      world_info_settings: { world_info: { globalSelect: [] } },
      extension_settings: {
        memory: {
          position: summary === "macro" ? -1 : 1,
          depth: 3,
          role: 0,
          template: "[Story so far: {{summary}}]"
        },
        note: { default: "", defaultPosition: 1, defaultDepth: 4, defaultRole: 0, defaultInterval: 1 },
        disabledExtensions: summary === "disabled" ? ["memory"] : []
      },
      oai_settings: { preset_settings_openai: "Celia 4.2" }
    })
  )
  for (const persona of PERSONAS) put(`User Avatars/${persona.file}`, card(persona.name, ""))

  const files_ = CARDS.map((spec) => ({ ...spec, file: chubFile(spec.name, spec.hash) }))
  for (const spec of files_) {
    const description = `${spec.name} is ${spec.role}. ${prose(next, 30)}\n\n${prose(next, 30)}`
    const book = spec.book
      ? { name: `${spec.name}'s lore`, entries: [{ keys: ["harbor"], content: prose(next, 3), id: 0, enabled: true }] }
      : undefined
    put(
      `characters/${spec.file}.png`,
      card(
        spec.name,
        `*${prose(next, 5)}* "Well, {{user}}? Are you coming or not?"`,
        { world: spec.book ? `${spec.file.replace("_spec_v2", "")}_sillytavern` : "", talkativeness: "0.5" },
        {
          ...(book ? { character_book: book } : {}),
          description,
          personality: `Guarded, dry, loyal to a fault. ${prose(next, 4)}`,
          scenario: `{{user}} meets ${spec.name} in Saltmarsh. ${prose(next, 6)}`,
          mes_example: `<START>\n{{user}}: Where were you last night?\n{{char}}: *${prose(next, 3)}* "Out."`,
          creator_notes: `<p>Made for slow-burn stories.</p><p>Works best with <b>long replies</b>.</p>`,
          alternate_greetings: [prose(next, 6), prose(next, 6)],
          tags: ["fantasy", "slow burn"]
        }
      )
    )
  }

  // Single chats: several per card, ST's file names, different lengths.
  let day = Date.UTC(2026, 0, 3, 18)
  const singles = [
    { card: 0, chats: [180, 40, 12] },
    { card: 1, chats: [420, 260, 90, 30, 8] },
    { card: 2, chats: [140] },
    { card: 4, chats: [60, 22] },
    { card: 6, chats: [15] },
    { card: 7, chats: [300, 35] },
    { card: 9, chats: [220, 110, 48, 16] }
  ]
  for (const { card: index, chats } of singles) {
    const spec = files_[index]!
    for (const [n, count] of chats.entries()) {
      day += 86_400_000 * (1 + Math.floor(next() * 9))
      const name = `${spec.name} - ${stamp(new Date(day))}`
      const lines = chatLines(next, [{ name: spec.name }], PERSONAS[n % 2]!, count, day, {
        ...(count > 200 ? { hiddenRun: Math.floor(count / 2) } : {})
      })
      put(`chats/${spec.file}/${name}.jsonl`, jsonl(lines))
      // A branch off the longest chat, as ST saves one.
      if (n === 0 && count > 150) {
        const cut = Math.floor(count * 0.8)
        const branch = [
          header({ main_chat: name }),
          ...lines.slice(1, cut),
          ...chatLines(next, [{ name: spec.name }], PERSONAS[0]!, 20, day + 1e9).slice(1)
        ]
        put(`chats/${spec.file}/${name} - Branch #1.jsonl`, jsonl(branch))
      }
    }
  }
  // A card downloaded again: its old chats sit in the "(1)" folder.
  const rook = files_[8]!
  put(
    `chats/${rook.file} (1)/${rook.name} - ${stamp(new Date(day + 3e8))}.jsonl`,
    jsonl(chatLines(next, [{ name: rook.name }], PERSONAS[0]!, 70, day))
  )

  // Group chats, which the owner uses most.
  const groups = [
    { id: "1712345678901", name: "The Lantern Inn", members: [3, 0, 8, 6], chats: [380, 150, 24] },
    { id: "1723456789012", name: "Station Kepler", members: [11, 7, 4], chats: [260, 60] },
    { id: "1734567890123", name: "Masquerade at Corvina Hall", members: [5, 2, 8, 0, 3], chats: [90] }
  ]
  for (const group of groups) {
    const members = group.members.map((i) => files_[i]!)
    const chatIds: Array<string> = []
    for (const count of group.chats) {
      day += 86_400_000 * (1 + Math.floor(next() * 6))
      const id = stamp(new Date(day))
      chatIds.push(id)
      const speakers = members.map((m) => ({ name: m.name, avatar: `${m.file}.png` }))
      put(
        `group chats/${id}.jsonl`,
        jsonl(
          chatLines(next, speakers, PERSONAS[2]!, count, day, {
            group: true,
            ...(count > 300 ? { hiddenRun: 120 } : {})
          })
        )
      )
    }
    put(
      `groups/${group.id}.json`,
      encode({
        id: group.id,
        name: group.name,
        members: members.map((m) => `${m.file}.png`),
        disabled_members: [],
        chats: chatIds,
        chat_id: chatIds[0]
      })
    )
  }
  // ST makes these just by opening a card: skipped on import.
  put(
    `chats/${files_[10]!.file}/${files_[10]!.name} - ${stamp(new Date(day))}.jsonl`,
    jsonl([header({}), message(next, { name: files_[10]!.name, user: false, at: day })])
  )

  const userRoot = join(root, "SillyTavern/data/default-user")
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(userRoot, path)), { recursive: true })
    writeFileSync(join(userRoot, path), bytes)
  }
  return userRoot
}

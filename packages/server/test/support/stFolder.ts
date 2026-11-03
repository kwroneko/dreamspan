// A synthetic SillyTavern data folder, made by code for the folder import's tests. Nothing
// here comes from real ST data: the names, texts and settings are made up, and the shapes
// follow ST's public source (public/global.d.ts, scripts/personas.js, extensions/memory).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { cardChunk, png, worldInfo } from "../formats/support.ts"

export const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
export const jsonl = (lines: ReadonlyArray<unknown>) =>
  new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n"))

/** A V2 card as ST keeps it in `characters/`. */
/** `more` adds or replaces fields of the card's `data` (a `character_book`, say). */
export const card = (
  name: string,
  firstMes: string,
  extensions: Record<string, unknown> = {},
  more: Record<string, unknown> = {},
  /** ST's own fields beside `data`: `chat` (the chat ST opens it on), `create_date`. */
  root: Record<string, unknown> = {}
) =>
  png(
    cardChunk("chara", {
      ...root,
      name,
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name,
        description: `${name} is made up for a test.`,
        personality: "",
        scenario: "",
        first_mes: firstMes,
        mes_example: "",
        creator_notes: "",
        system_prompt: "",
        post_history_instructions: "",
        tags: [],
        creator: "tests",
        character_version: "1",
        alternate_greetings: [],
        extensions,
        ...more
      }
    })
  )

const at = (minute: number) => new Date(Date.UTC(2025, 0, 1, 10, minute)).toISOString()

interface Message {
  readonly name: string
  readonly user?: boolean
  readonly hidden?: boolean
  readonly mes: string
  readonly minute: number
  readonly swipes?: ReadonlyArray<string>
  readonly swipeId?: number
  readonly reasoning?: string
  readonly memory?: string
  readonly avatar?: string
  readonly persona?: string
}

export const message = (m: Message) => ({
  name: m.name,
  is_user: m.user ?? false,
  is_system: m.hidden ?? false,
  send_date: at(m.minute),
  mes: m.mes,
  ...(m.swipes
    ? {
        swipes: m.swipes,
        swipe_id: m.swipeId ?? 0,
        swipe_info: m.swipes.map(() => ({ send_date: at(m.minute), extra: {} }))
      }
    : {}),
  ...(m.avatar
    ? { original_avatar: m.avatar, force_avatar: `/thumbnail?type=avatar&file=${encodeURIComponent(m.avatar)}` }
    : {}),
  ...(m.persona ? { force_avatar: `/thumbnail?type=persona&file=${encodeURIComponent(m.persona)}` } : {}),
  extra: { ...(m.reasoning ? { reasoning: m.reasoning } : {}), ...(m.memory ? { memory: m.memory } : {}) }
})

export const header = (metadata: Record<string, unknown>) => ({
  chat_metadata: { integrity: "00000000-0000-4000-8000-000000000000", ...metadata },
  user_name: "unused",
  character_name: "unused"
})

const aliceMetadata = {
  note_prompt: "Keep it gentle.",
  note_position: 1,
  note_depth: 2,
  note_role: 0,
  note_interval: 1,
  variables: { mood: "calm", count: 3 },
  world_info: "Hollow"
}

/** Alice's main chat: an author's note, variables, a world, swipes, reasoning, a persona. */
const aliceMain = [
  header(aliceMetadata),
  message({ name: "Alice", mes: "Hello Sam, I am Alice.", minute: 0, swipes: ["Hello Sam, I am Alice.", "Hi there."] }),
  message({ name: "Sam", user: true, mes: "Hi Alice.", minute: 1, persona: "user.png" }),
  message({
    name: "Alice",
    mes: "Shall we walk?",
    minute: 2,
    swipes: ["We could sit.", "Shall we walk?"],
    swipeId: 1,
    reasoning: "She wants to move."
  }),
  message({ name: "Sam", user: true, mes: "Yes.", minute: 3, persona: "user.png" }),
  message({ name: "Alice", mes: "To the river, then.", minute: 4 })
]

export const ALICE_MAIN = "Alice - 2025-01-01@10h00m00s"

/** A branch from Alice's third message, which goes elsewhere. */
const aliceBranch = [
  header({ ...aliceMetadata, main_chat: ALICE_MAIN, note_prompt: "Keep it tense." }),
  ...aliceMain.slice(1, 4),
  message({ name: "Sam", user: true, mes: "No, let's stay.", minute: 5, persona: "user.png" }),
  message({ name: "Alice", mes: "As you wish.", minute: 6 })
]

/** Bob's long chat: 15 messages hidden from the start, summaries on several messages. */
const bobLong = [
  header({}),
  ...Array.from({ length: 15 }, (_, i) =>
    message({
      name: i % 2 === 0 ? "Bob" : "Sam",
      user: i % 2 === 1,
      hidden: true,
      mes: `Old message ${i}.`,
      minute: i,
      ...(i === 7 ? { memory: "Bob and Sam met." } : {}),
      ...(i === 14 ? { memory: "Bob and Sam met, then argued." } : {})
    })
  ),
  message({ name: "Sam", user: true, mes: "Where were we?", minute: 20 }),
  message({ name: "Bob", mes: "Arguing.", minute: 21, memory: "On the last message, which ST ignores." })
]

/** Mira's card file was renamed; her chats keep the old folder name, which is her name. */
const miraChat = [
  header({ note_prompt: "Summary: Mira lost her map.", note_position: 0 }),
  message({ name: "Mira", mes: "Where is my map?", minute: 0 }),
  message({ name: "Sam", user: true, mes: "Not here.", minute: 1 }),
  message({ name: "Mira", mes: "Then we search.", minute: 2, memory: "Mira is looking for her map." }),
  message({ name: "Sam", user: true, mes: "Fine.", minute: 3 })
]

/** A chat in a folder no card is named after, whose greeting is Wren's. */
const ghostChat = [
  header({}),
  message({ name: "Wren", mes: "The lamp needs oil, Kim.", minute: 0 }),
  message({ name: "Kim", user: true, mes: "I'll fetch it.", minute: 1, persona: "other.png" })
]

/** Two cards share a name, so their folder's chat can't be told apart. */
const twinChat = [
  header({}),
  message({ name: "Twin", mes: "Which one am I?", minute: 0 }),
  message({ name: "Sam", user: true, mes: "Hard to say.", minute: 1 })
]

const greetingOnly = [header({}), message({ name: "Alice", mes: "Hello Sam, I am Alice.", minute: 0 })]

const groupChat = [
  header({ variables: { scene: "inn" } }),
  message({ name: "Alice", mes: "Welcome to the inn.", minute: 0, avatar: "Alice.png" }),
  message({ name: "Sam", user: true, mes: "Thanks.", minute: 1, persona: "user.png" }),
  message({ name: "Bob", mes: "Bob nods.", minute: 2, avatar: "Bob.png" }),
  message({ name: "Alice", mes: "Sit down.", minute: 3, avatar: "Alice.png" })
]

const settings = {
  username: "Sam",
  user_avatar: "user.png",
  power_user: {
    personas: { "user.png": "Sam", "other.png": "Kim" },
    persona_descriptions: {
      "user.png": { description: "Sam is curious.", position: 0, depth: 2, role: 0 },
      "other.png": { description: "Kim carries a lantern.", position: 4, depth: 3, role: 1 }
    },
    default_persona: "user.png"
  },
  world_info_settings: { world_info: { globalSelect: ["Hollow"] } },
  extension_settings: {
    memory: { position: 1, depth: 3, role: 0, template: "[Story so far: {{summary}}]" },
    note: { default: "", defaultPosition: 1, defaultDepth: 4, defaultRole: 0, defaultInterval: 1 },
    disabledExtensions: []
  },
  oai_settings: { preset_settings_openai: "Default" }
}

/** The folder's files by path, under `prefix` (e.g. `data/default-user/`). */
export const stFolder = (prefix = ""): ReadonlyMap<string, Uint8Array> =>
  new Map(
    (
      [
        ["settings.json", encode(settings)],
        ["User Avatars/user.png", png()],
        ["User Avatars/other.png", png()],
        // ST opens Alice on her main chat, though its branch has the latest message.
        [
          "characters/Alice.png",
          card("Alice", "Hello {{user}}, I am Alice.", { world: "Hollow" }, {}, { chat: ALICE_MAIN })
        ],
        ["characters/Bob.png", card("Bob", "Bob waves.")],
        ["characters/Mira_new.png", card("Mira", "Where is my map?")],
        ["characters/Wren.png", card("Wren", "The lamp needs oil, {{user}}.")],
        ["characters/Twin_a.png", card("Twin", "Which one am I?")],
        ["characters/Twin_b.png", card("Twin", "Which one am I?", { variant: "b" })],
        ["worlds/Hollow.json", encode(worldInfo())],
        [
          "OpenAI Settings/Default.json",
          new Uint8Array(readFileSync(new URL("../fixtures/presets/default.json", import.meta.url)))
        ],
        [
          "groups/g1.json",
          encode({
            id: "g1",
            name: "Party",
            members: ["Alice.png", "Bob.png"],
            disabled_members: ["Bob.png"],
            chats: ["Party - 2025"],
            chat_id: "Party - 2025"
          })
        ],
        [`chats/Alice/${ALICE_MAIN}.jsonl`, jsonl(aliceMain)],
        [`chats/Alice/${ALICE_MAIN} - Branch #1.jsonl`, jsonl(aliceBranch)],
        ["chats/Alice/Alice - greeting.jsonl", jsonl(greetingOnly)],
        ["chats/Bob/Bob - long.jsonl", jsonl(bobLong)],
        ["chats/Mira/Mira - map.jsonl", jsonl(miraChat)],
        ["chats/Ghost/Ghost - lamp.jsonl", jsonl(ghostChat)],
        ["chats/Twin/Twin - who.jsonl", jsonl(twinChat)],
        ["group chats/Party - 2025.jsonl", jsonl(groupChat)],
        ["TextGen Settings/Creative.json", encode({ temp: 1 })],
        ["instruct/Alpaca.json", encode({ input_sequence: "### Instruction:" })],
        ["backups/chat_alice_20250101.jsonl", jsonl(aliceMain)],
        ["secrets.json", encode({ api_key_openai: "sk-not-a-real-key" })]
      ] as const
    ).map(([path, bytes]) => [`${prefix}${path}`, bytes])
  )

/** A chat of `count` messages, every third with three swipes, for measuring a large import. */
export const largeChat = (count: number) => {
  const lines: Array<string> = [JSON.stringify(header({ note_prompt: "Large." }))]
  const body = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(18)
  for (let i = 0; i < count; i++) {
    const user = i % 2 === 1
    const mes = `${i}: ${body}`
    lines.push(
      JSON.stringify(
        message({
          name: user ? "Sam" : "Alice",
          user,
          mes,
          minute: i,
          ...(!user && i % 3 === 0 ? { swipes: [mes, `${i} b: ${body}`, `${i} c: ${body}`] } : {})
        })
      )
    )
  }
  return new TextEncoder().encode(lines.join("\n"))
}

/** Long, swipe-heavy branches, including branches of branches. Only synthetic text.
 * Files are generated one at a time; keeping a whole big family in memory hides the
 * import's own memory use. Each branch has N messages, with a random 80–99% prefix.
 */
export const writeStBranchFamily = (
  root: string,
  options: {
    branches: number
    messages: number
    swipeShare?: number
    swipes?: number
    bodyRepeats?: number
    name?: string
    seed?: number
  }
) => {
  const { branches, messages, swipeShare = 0.3, name = "Alice" } = options
  let seed = options.seed ?? 12345
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 0x100000000
  }
  const files: Array<{ path: string; name: string; parent: number; prefix: number; bytes: number }> = []
  let uniqueMessages = 0
  let uniqueVersions = 0
  const body = "The harbor lamps shone on the water while the travelers discussed their next journey. "
  for (let branch = 0; branch <= branches; branch++) {
    const parent = branch === 0 ? -1 : branch % 3 === 1 ? 0 : Math.floor(random() * branch)
    const prefix = parent < 0 ? 0 : Math.floor(messages * (0.8 + random() * 0.19))
    const lines =
      parent < 0
        ? []
        : readFileSync(join(root, files[parent]!.path), "utf8")
            .split("\n")
            .slice(1, prefix + 1)
    for (let i = prefix; i < messages; i++) {
      const user = i % 2 === 1
      const repeats = 12 + Math.floor(random() * 24)
      const text = `${name} branch ${branch}, message ${i}: ${body.repeat(options.bodyRepeats ?? repeats)}`
      const swipes =
        !user && random() < swipeShare
          ? Array.from(
              { length: options.swipes ?? 20 + Math.floor(random() * 31) },
              (_, swipe) => `${text} Version ${swipe}.`
            )
          : undefined
      const selected = swipes === undefined ? 0 : Math.floor(random() * swipes.length)
      lines.push(
        JSON.stringify(
          message({
            name: user ? "Sam" : name,
            user,
            minute: i,
            mes: swipes?.[selected] ?? text,
            ...(swipes === undefined ? {} : { swipes, swipeId: selected }),
            ...(i % 193 === 0 ? { memory: `A synthetic memory at ${i}.` } : {})
          })
        )
      )
      uniqueMessages++
      uniqueVersions += swipes?.length ?? 1
    }
    const fileName =
      branch === 0
        ? `${name} - main`
        : `Branch #${prefix - 1} - 2025-12-27@12h00m00s${String(branch).padStart(3, "0")}ms`
    const path = `chats/${name}/${fileName}.jsonl`
    const text = [
      JSON.stringify(
        header({
          note_prompt: "Remember the harbor.",
          variables: { place: "harbor" },
          ...(parent < 0 ? {} : { main_chat: files[parent]!.name })
        })
      ),
      ...lines
    ].join("\n")
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
    files.push({ path, name: fileName, parent, prefix, bytes: Buffer.byteLength(text) })
  }
  return {
    files,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    messageLines: messages * files.length,
    uniqueMessages,
    uniqueVersions
  }
}

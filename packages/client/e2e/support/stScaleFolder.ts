// A synthetic SillyTavern user folder at a heavy user's scale, for the browser tests that
// use the app the way that user would (scale.spec.ts): hundreds of cards with avatars of
// a real portrait's size, thousands of chats, a few of thousands of messages, groups,
// lorebooks and personas. Every name, text and pixel is made up here.
import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { crc32, deflateSync } from "node:zlib"

export interface ScaleOptions {
  readonly cards: number
  readonly chats: number
  /** Chats of 5,000 to 8,000 messages, among `chats`. */
  readonly longChats: number
  readonly groups: number
}

const chunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(12 + data.byteLength)
  out.writeUInt32BE(data.byteLength, 0)
  out.write(type, 4, "latin1")
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.byteLength)), 8 + data.byteLength)
  return out
}

/** An RGB portrait, part noise so it compresses as a photo does: 1 to 3 MB at these sizes. */
const portrait = (width: number, height: number, extra: ReadonlyArray<Buffer>) => {
  const row = width * 3 + 1
  const raw = randomBytes(row * height)
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0
    for (let x = 0; x < width * 3; x++) {
      const i = y * row + 1 + x
      raw[i] = ((x * 7 + y * 3) & 0xff) ^ (raw[i]! & 0x3f)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 3 })),
    ...extra,
    chunk("IEND", Buffer.alloc(0))
  ])
}

const WORDS =
  "the lantern river bridge night storm quiet harbor tavern road forest letter sword promise smile rain".split(" ")

/**
 * Writes the folder at `root/data/default-user` and returns what it holds. Cards are named
 * `Card 000 …`; chats go to cards on a power law (a few favourites hold most of them), and
 * every chat's messages are dated within the last 400 days.
 */
export const writeScaleFolder = (root: string, options: ScaleOptions) => {
  let seed = 12345
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const pick = <A>(xs: ReadonlyArray<A>) => xs[Math.floor(rand() * xs.length)]!
  const sentence = () => Array.from({ length: 8 + Math.floor(rand() * 12) }, () => pick(WORDS)).join(" ") + "."
  const paragraph = () => Array.from({ length: 3 + Math.floor(rand() * 6) }, sentence).join(" ")
  const user = join(root, "data", "default-user")
  for (const dir of ["characters", "chats", "group chats", "groups", "worlds", "User Avatars"])
    mkdirSync(join(user, dir), { recursive: true })
  const personas = ["Sam", "Kim", "Ari"]
  writeFileSync(
    join(user, "settings.json"),
    JSON.stringify({
      username: "Sam",
      user_avatar: "p0.png",
      power_user: {
        personas: Object.fromEntries(personas.map((name, i) => [`p${i}.png`, name])),
        persona_descriptions: Object.fromEntries(
          personas.map((name, i) => [`p${i}.png`, { description: `${name} is made up.`, position: 0 }])
        ),
        default_persona: "p0.png"
      }
    })
  )
  personas.forEach((_, i) => writeFileSync(join(user, "User Avatars", `p${i}.png`), portrait(256, 256, [])))
  for (let i = 0; i < 10; i++)
    writeFileSync(
      join(user, "worlds", `World ${i}.json`),
      JSON.stringify({ entries: { "0": { uid: 0, key: ["harbor"], content: `World ${i}'s harbor.`, comment: "" } } })
    )
  const names: Array<string> = []
  for (let i = 0; i < options.cards; i++) {
    const name = `Card ${String(i).padStart(3, "0")} ${pick(["Vale", "Moss", "Quill", "Ember", "Shade", "Wren"])}`
    names.push(name)
    const width = 560 + Math.floor(rand() * 300)
    const card = {
      name,
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name,
        description: `${name} is made up. ${paragraph()}`,
        personality: paragraph(),
        scenario: paragraph(),
        first_mes: `${name} greets {{user}}. ${paragraph()}`,
        mes_example: "",
        creator_notes: "",
        system_prompt: "",
        post_history_instructions: "",
        tags: [],
        creator: "synthetic",
        character_version: "1",
        alternate_greetings: [],
        extensions: i % 10 === 0 ? { world: `World ${i % 10}` } : {}
      }
    }
    const text = Buffer.from(`chara\0${Buffer.from(JSON.stringify(card)).toString("base64")}`, "latin1")
    writeFileSync(
      join(user, "characters", `${name}.png`),
      portrait(width, Math.floor(width * 1.45), [chunk("tEXt", text)])
    )
  }
  const now = Date.now()
  let messages = 0
  const writeChat = (
    path: string,
    count: number,
    start: number,
    speaker: (i: number) => { name: string; user: boolean; avatar?: string }
  ) => {
    const persona = pick(personas)
    const lines = [JSON.stringify({ chat_metadata: {}, user_name: "unused", character_name: "unused" })]
    for (let i = 0; i < count; i++) {
      const s = speaker(i)
      const mes = paragraph()
      const date = new Date(start + i * 90_000).toISOString()
      const swipes = !s.user && rand() < 0.25 ? [mes, paragraph()] : null
      lines.push(
        JSON.stringify({
          name: s.user ? persona : s.name,
          is_user: s.user,
          is_system: false,
          send_date: date,
          mes,
          ...(swipes ? { swipes, swipe_id: 0, swipe_info: swipes.map(() => ({ send_date: date, extra: {} })) } : {}),
          ...(s.user ? { force_avatar: `/thumbnail?type=persona&file=p${personas.indexOf(persona)}.png` } : {}),
          ...(s.avatar ? { original_avatar: s.avatar } : {}),
          extra: {}
        })
      )
    }
    messages += count
    writeFileSync(path, lines.join("\n"))
  }
  const used = new Set<string>()
  for (let c = 0; c < options.chats; c++) {
    const card = names[Math.min(names.length - 1, Math.floor(Math.pow(rand(), 2.2) * names.length))]!
    used.add(card)
    mkdirSync(join(user, "chats", card), { recursive: true })
    const r = rand()
    const count =
      c < options.longChats
        ? 5000 + Math.floor(rand() * 3000)
        : r < 0.1
          ? 1
          : r < 0.7
            ? 4 + Math.floor(rand() * 40)
            : r < 0.97
              ? 50 + Math.floor(rand() * 400)
              : 800 + Math.floor(rand() * 1500)
    const start = now - Math.floor(rand() * 400) * 86_400_000
    writeChat(join(user, "chats", card, `${card} - chat ${c}.jsonl`), count, start, (i) => ({
      name: card,
      user: i % 2 === 1
    }))
  }
  for (let g = 0; g < options.groups; g++) {
    const members = [pick(names), pick(names), pick(names)]
    const chats = [`Group ${g} - chat 0`, `Group ${g} - chat 1`]
    writeFileSync(
      join(user, "groups", `g${g}.json`),
      JSON.stringify({
        id: `g${g}`,
        name: `Group ${g}`,
        members: members.map((name) => `${name}.png`),
        disabled_members: [],
        chats,
        chat_id: chats[0]
      })
    )
    for (const name of chats)
      writeChat(join(user, "group chats", `${name}.jsonl`), 20 + Math.floor(rand() * 200), now - g * 86_400_000, (i) =>
        i % 2 === 1 ? { name: "", user: true } : { name: members[i % 3]!, user: false, avatar: `${members[i % 3]}.png` }
      )
  }
  return { names, used, messages }
}

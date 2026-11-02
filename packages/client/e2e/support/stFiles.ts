// Files of a synthetic ST folder for browser tests, written to disk for the folder picker:
// a card and chats that begin with a hidden run ST summarized. Every text here is made up.
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { crc32, deflateSync } from "node:zlib"

const pngChunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(12 + data.byteLength)
  out.writeUInt32BE(data.byteLength, 0)
  out.write(type, 4, "latin1")
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.byteLength)), 8 + data.byteLength)
  return out
}

const card = (name: string, firstMes: string, root: Record<string, unknown> = {}) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 128]))),
    pngChunk(
      "tEXt",
      Buffer.from(
        `chara\0${Buffer.from(
          JSON.stringify({ ...root, spec: "chara_card_v2", spec_version: "2.0", data: { name, first_mes: firstMes } })
        ).toString("base64")}`,
        "latin1"
      )
    ),
    pngChunk("IEND", Buffer.alloc(0))
  ])

export const IMPORTED_SUMMARY = "Bob and Sam met at the bridge, and argued about the toll."

const at = (minute: number) => new Date(Date.UTC(2025, 0, 1, 10, minute)).toISOString()
const body = (n: number) => `${n}: ` + "The lantern swung over the bridge and the river ran loud below. ".repeat(5)

/** A chat whose first `hidden` messages ST hid and summarized, followed by `visible` more. */
const chat = (hidden: number, visible: number) =>
  [
    { chat_metadata: {}, user_name: "unused", character_name: "unused" },
    ...Array.from({ length: hidden + visible }, (_, i) => ({
      name: i % 2 ? "Sam" : "Bob",
      is_user: i % 2 === 1,
      is_system: i < hidden,
      send_date: at(i),
      mes: body(i),
      extra: i === hidden - 1 ? { memory: IMPORTED_SUMMARY } : {}
    }))
  ]
    .map((line) => JSON.stringify(line))
    .join("\n")

/** Writes an ST user folder at `root/ST/data/default-user` with these chats, each 12 hidden and 36 visible messages. */
export const writeStFolder = (root: string, chats: ReadonlyArray<string>) => {
  const files: Record<string, string | Buffer> = {
    "characters/Bob.png": card("Bob", "Bob waves."),
    ...Object.fromEntries(chats.map((name) => [`chats/Bob/${name}.jsonl`, chat(12, 36)]))
  }
  return writeFiles(root, files)
}

const turns = (metadata: Record<string, unknown>, character: string, from: number, count: number, avatar?: string) =>
  [
    { chat_metadata: metadata, user_name: "unused", character_name: "unused" },
    ...Array.from({ length: count }, (_, i) => ({
      name: i % 2 ? "Sam" : character,
      is_user: i % 2 === 1,
      is_system: false,
      send_date: at(from + i),
      mes: i % 2 ? `Sam's turn ${i}.` : `${character}'s turn ${i}.`,
      ...(i % 2 === 0 && avatar ? { original_avatar: avatar } : {}),
      extra: {}
    }))
  ]
    .map((line) => JSON.stringify(line))
    .join("\n")

/** ST's author's note at depth 2 in a chat's metadata, where the folder's default is at depth 4. */
const noteAtTwo = { note_prompt: "Rain.", note_position: 1, note_depth: 2, note_role: 0, note_interval: 1 }

/**
 * A folder whose import report has one warning on many chats and a rarer one: Dax's own author's
 * note (which ST applies) rode on each of his twelve chats' notes, at depth 2 rather than the
 * default's depth 4, and one of Cleo's chats names a lorebook that isn't there. Cleo's latest chat
 * is named by an older ST stamp from years before its first message, and the group of the two
 * replies in list order.
 */
export const writeStReportFolder = (root: string) => {
  const files: Record<string, string | Buffer> = {
    "settings.json": JSON.stringify({
      username: "Sam",
      user_avatar: "user.png",
      power_user: {
        personas: { "user.png": "Sam" },
        persona_descriptions: { "user.png": { description: "Sam is tall.", position: 0, depth: 2, role: 0 } },
        default_persona: "user.png"
      },
      extension_settings: {
        note: {
          default: "",
          defaultPosition: 1,
          defaultDepth: 4,
          defaultRole: 0,
          defaultInterval: 1,
          chara: [{ name: "Dax", prompt: "Dax squints.", useChara: true, position: 1 }]
        },
        disabledExtensions: []
      }
    }),
    "characters/Dax.png": card("Dax", "Dax's turn 0."),
    "characters/Cleo.png": card("Cleo", "Cleo's turn 0."),
    ...Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`chats/Dax/Dax - ${i + 1}.jsonl`, turns(noteAtTwo, "Dax", i, 4)])
    ),
    "chats/Cleo/Cleo - lost.jsonl": turns({ ...noteAtTwo, world_info: "Gone Book" }, "Cleo", 0, 4),
    "chats/Cleo/2024-9-10 @13h 44m 41s 16ms.jsonl": turns({}, "Cleo", 40, 6),
    "groups/g.json": JSON.stringify({
      id: "g",
      name: "Both",
      members: ["Cleo.png", "Dax.png"],
      disabled_members: [],
      chats: ["Both - 1"],
      activation_strategy: 1
    }),
    "group chats/Both - 1.jsonl": turns({}, "Cleo", 20, 4, "Cleo.png")
  }
  return writeFiles(root, files)
}

const writeFiles = (root: string, files: Record<string, string | Buffer>) => {
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, "ST/data/default-user", path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  return join(root, "ST")
}

const jsonl = (lines: ReadonlyArray<unknown>) => lines.map((line) => JSON.stringify(line)).join("\n")
const day = (d: number, h: number, m: number) => new Date(Date.UTC(2025, 0, d, h, m)).toISOString()

/** ST's names for two branch files, as older versions wrote them. */
const ST_BRANCHES = ["Branch #4 - 2025-01-12@21h40m51s", "Branch #4 - 2025-01-13@08h00m00s"] as const

/**
 * A chat of `who` with Sam that two branches split off at its fourth message: the first on 12
 * Jan at 21:40, the second, with the latest message, on 13 Jan. `lead` heads each of its lines.
 */
const family = (who: string, me: string, main: string, lead: string) => {
  const shared = Array.from({ length: 4 }, (_, i) => ({
    name: i % 2 ? me : who,
    is_user: i % 2 === 1,
    send_date: day(10, 9, i),
    mes: `${lead} ${i + 1}: they talk on the bridge.`
  }))
  const own = (d: number, h: number, m: number, texts: ReadonlyArray<string>) =>
    texts.map((mes, i) => ({ name: i % 2 ? who : me, is_user: i % 2 === 0, send_date: day(d, h, m + i), mes }))
  const head = (mainChat: string | null) => ({
    chat_metadata: mainChat === null ? {} : { main_chat: mainChat },
    user_name: "unused",
    character_name: "unused"
  })
  return {
    [main]: jsonl([head(null), ...shared, ...own(11, 9, 0, [`${lead}: the main line goes on.`])]),
    [ST_BRANCHES[0]]: jsonl([
      head(main),
      ...shared,
      ...own(12, 21, 40, [`${lead}: the first branch turns back.`, `${lead}: they head home.`])
    ]),
    [ST_BRANCHES[1]]: jsonl([head(main), ...shared, ...own(13, 8, 0, [`${lead}: the second branch crosses over.`])])
  }
}

/**
 * An ST folder of branch families (owner, 2026-11-01): a group chat whose `chat_id` names its
 * first branch, though its second has the latest message, and a solo chat whose card's `chat`
 * names its first branch too.
 */
export const writeStBranchFamilies = (root: string) => {
  const groupMain = "2025-1-10@09h00m00s000ms"
  const soloMain = "Bob - 2025-1-10@09h00m00s000ms"
  const files: Record<string, string | Buffer> = {
    "characters/Mika.png": card("Mika", "Mika waves."),
    "characters/Kuro.png": card("Kuro", "Kuro nods."),
    "characters/Bob.png": card("Bob", "Bob waves.", { chat: ST_BRANCHES[0] }),
    "groups/g1.json": JSON.stringify({
      id: "g1",
      name: "Mika and Kuro",
      members: ["Mika.png", "Kuro.png"],
      chats: [groupMain, ...ST_BRANCHES],
      chat_id: ST_BRANCHES[0]
    }),
    ...Object.fromEntries(
      Object.entries(family("Mika", "Sam", groupMain, "Group")).map(([name, text]) => [
        `group chats/${name}.jsonl`,
        text
      ])
    ),
    ...Object.fromEntries(
      Object.entries(family("Bob", "Sam", soloMain, "Solo")).map(([name, text]) => [`chats/Bob/${name}.jsonl`, text])
    )
  }
  return writeFiles(root, files)
}

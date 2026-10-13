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

const card = (name: string, firstMes: string) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 128]))),
    pngChunk(
      "tEXt",
      Buffer.from(
        `chara\0${Buffer.from(
          JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name, first_mes: firstMes } })
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
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, "ST/data/default-user", path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  return join(root, "ST")
}

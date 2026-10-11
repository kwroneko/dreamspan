// Synthetic fixtures and helpers for the format parser tests. Every card here is made up.
import { crc32, deflateRawSync, deflateSync } from "node:zlib"
import { Effect } from "effect"
import type { FormatError } from "../../src/formats/safety.ts"

export const chunk = (type: string, data: Uint8Array = new Uint8Array()) => {
  const out = Buffer.alloc(12 + data.byteLength)
  out.writeUInt32BE(data.byteLength, 0)
  out.write(type, 4, "latin1")
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.byteLength)), 8 + data.byteLength)
  return out
}

export const textChunk = (keyword: string, text: string) => chunk("tEXt", Buffer.from(`${keyword}\0${text}`, "latin1"))

export const cardChunk = (keyword: string, card: unknown) =>
  textChunk(keyword, Buffer.from(JSON.stringify(card)).toString("base64"))

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A 1×1 grey PNG with `extra` chunks before IEND. */
export const png = (...extra: Array<Uint8Array>) =>
  Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
    chunk("IDAT", deflateSync(Buffer.from([0, 128]))),
    ...extra,
    chunk("IEND")
  ])

export const run = <A>(effect: Effect.Effect<A, FormatError>): A => Effect.runSync(effect)

/** The `FormatError` code an effect fails with. */
export const failure = <A>(effect: Effect.Effect<A, FormatError>): string => Effect.runSync(Effect.flip(effect)).code

export const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

/** A V2 card as ST exports it: V1 copies and its local state next to `data`. */
export const stCardV2 = () => ({
  name: "Wren",
  description: "A lighthouse keeper.",
  personality: "Patient.",
  scenario: "A storm night.",
  first_mes: "The lamp needs oil.",
  mes_example: "<START>\n{{char}}: Mind the stairs.",
  creatorcomment: "Made for testing.",
  avatar: "none",
  chat: "Wren - 2026-01-01@12h00m00s",
  talkativeness: "0.5",
  fav: false,
  tags: ["sea"],
  create_date: "2026-01-01T12:00:00.000Z",
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "Wren",
    description: "A lighthouse keeper.",
    personality: "Patient.",
    scenario: "A storm night.",
    first_mes: "The lamp needs oil.",
    mes_example: "<START>\n{{char}}: Mind the stairs.",
    creator_notes: "Made for testing.",
    system_prompt: "Stay in character.",
    post_history_instructions: "Keep replies short.",
    tags: ["sea"],
    creator: "tester",
    character_version: "1.2",
    alternate_greetings: ["Another storm.", "Fog again."],
    extensions: {
      talkativeness: "0.5",
      fav: false,
      world: "Hollowmere",
      depth_prompt: { prompt: "Wren smells of oil.", depth: 4, role: "system" },
      "some-plugin": { mood: "calm", nested: { level: 2 } }
    },
    character_book: {
      name: "Hollowmere",
      scan_depth: 3,
      extensions: { "some-plugin": true },
      entries: [
        {
          id: 7,
          keys: ["lighthouse", "lamp"],
          secondary_keys: ["storm"],
          comment: "the lighthouse",
          content: "The lighthouse is old.",
          constant: false,
          selective: true,
          insertion_order: 50,
          enabled: true,
          position: "after_char",
          use_regex: true,
          extensions: {
            position: 4,
            depth: 2,
            role: 1,
            selectiveLogic: 3,
            probability: 80,
            useProbability: true,
            group: "places",
            sticky: 2,
            delay_until_recursion: 1,
            display_index: 0,
            triggers: ["normal"],
            "some-plugin": { weight: 1 }
          }
        },
        { keys: ["Wren"], content: "Wren is tall.", insertion_order: 10, enabled: true, position: "after_char" }
      ]
    },
    an_unknown_field: { kept: true }
  },
  some_root_field: 42
})

/** A V3 card with the V3-only fields. */
export const cardV3 = () => ({
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "Moss",
    description: "A gardener.",
    personality: "",
    scenario: "",
    first_mes: "Hello.",
    mes_example: "",
    creator_notes: "Notes.",
    creator_notes_multilingual: { en: "Notes.", fr: "Notes en français." },
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    group_only_greetings: ["Hello, everyone."],
    nickname: "Mossy",
    source: ["https://example.com/moss"],
    tags: ["garden"],
    creator: "tester",
    character_version: "3",
    creation_date: 1_700_000_000,
    modification_date: 1_700_000_100,
    assets: [{ type: "icon", uri: "ccdefault:", name: "main", ext: "png" }],
    extensions: {}
  }
})

export interface ZipFile {
  readonly name: string
  readonly data: Uint8Array
  /** Deflated unless 0. */
  readonly method?: number
  /** Lies about the uncompressed size when set. */
  readonly declaredSize?: number
  readonly flags?: number
}

/** A zip archive written by hand, so tests can craft broken or hostile ones. */
export const zip = (files: ReadonlyArray<ZipFile>) => {
  const locals: Array<Buffer> = []
  const centrals: Array<Buffer> = []
  let offset = 0
  for (const file of files) {
    const method = file.method ?? 8
    const data = method === 8 ? deflateRawSync(file.data) : Buffer.from(file.data)
    const name = Buffer.from(file.name)
    const fields = (header: Buffer, at: number) => {
      header.writeUInt16LE(file.flags ?? 0, at)
      header.writeUInt16LE(method, at + 2)
      header.writeUInt32LE(crc32(file.data), at + 8)
      header.writeUInt32LE(data.byteLength, at + 12)
      header.writeUInt32LE(file.declaredSize ?? file.data.byteLength, at + 16)
      header.writeUInt16LE(name.byteLength, at + 20)
    }
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    fields(local, 6)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    fields(central, 8)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    centrals.push(central, name)
    offset += 30 + name.byteLength + data.byteLength
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** An ST World Info file, as ST saves one. */
export const worldInfo = () => ({
  entries: {
    "3": {
      uid: 3,
      key: ["harbor"],
      keysecondary: ["night"],
      comment: "the harbor",
      content: "The harbor freezes in winter.",
      constant: false,
      vectorized: false,
      selective: true,
      selectiveLogic: 2,
      addMemo: true,
      order: 20,
      position: 7,
      disable: true,
      ignoreBudget: true,
      excludeRecursion: true,
      preventRecursion: false,
      matchPersonaDescription: true,
      matchCharacterDescription: false,
      matchCharacterPersonality: false,
      matchCharacterDepthPrompt: false,
      matchScenario: false,
      matchCreatorNotes: false,
      delayUntilRecursion: 2,
      probability: 50,
      useProbability: false,
      depth: 6,
      outletName: "harbor-outlet",
      group: "places",
      groupOverride: true,
      groupWeight: 30,
      scanDepth: 5,
      caseSensitive: true,
      matchWholeWords: false,
      useGroupScoring: true,
      automationId: "auto",
      role: 2,
      sticky: 1,
      cooldown: 3,
      delay: 4,
      characterFilter: { isExclude: true, names: ["Wren.png"], tags: ["t1"] },
      triggers: ["continue"],
      displayIndex: 1,
      extensions: { "some-plugin": { x: 1 }, rp_harness: { decision_hint: "Is anyone at the harbor?", other: 2 } },
      someNewStField: "kept"
    },
    "9": { key: ["gull"], content: "Gulls nest on the roof." }
  },
  extensions: { "some-plugin": "book" },
  originalData: { name: "Old", scan_depth: 8, entries: [] },
  topLevelExtra: true
})

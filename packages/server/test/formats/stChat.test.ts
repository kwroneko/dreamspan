import { unreadChatPart } from "../../src/importer/stParse.ts"
// ST chat files and the rest of an ST folder (formats/stChat.ts, formats/stData.ts), on
// synthetic files. Each cap has a crafted file.
import { describe, expect, it } from "@effect/vitest"
import { ReportBuilder } from "@rp/shared/importReport.ts"
import { FormatError } from "../../src/formats/safety.ts"
import { parseStChatPart, parseStDate, type StMessage, stChatLimits } from "../../src/formats/stChat.ts"
import { parseStGroup, parseStSettings } from "../../src/formats/stData.ts"

const lines = (...values: ReadonlyArray<unknown>) =>
  new TextEncoder().encode(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("\n"))

const read = (bytes: Uint8Array, first = true, firstIndex = 0, carryAt: number | null = null) => {
  const issues = new ReportBuilder()
  const part = parseStChatPart(bytes, { first, firstIndex, carryAt }, issues)
  return { part, report: issues.build("st-chat") }
}

const messages = (batches: ReadonlyArray<{ messagesJson: string }>): Array<StMessage> =>
  batches.flatMap((b) => JSON.parse(b.messagesJson))

describe("ST dates", () => {
  it("reads every form ST reads", () => {
    expect(parseStDate("2025-01-01T10:00:00.000Z")).toBe(Date.UTC(2025, 0, 1, 10))
    expect(parseStDate(1735725600000)).toBe(1735725600000)
    expect(parseStDate("1735725600000")).toBe(1735725600000)
    expect(parseStDate("June 19, 2023 2:20pm")).toBe(Date.UTC(2023, 5, 19, 14, 20))
    expect(parseStDate("2024-07-12@01h31m37s123ms")).toBe(Date.UTC(2024, 6, 12, 1, 31, 37, 123))
    expect(parseStDate("2024-7-12@01h31m37s")).toBe(Date.UTC(2024, 6, 12, 1, 31, 37))
    expect(parseStDate("2024-6-5 @14h 56m 50s 682ms")).toBe(Date.UTC(2024, 5, 5, 14, 56, 50, 682))
    expect(parseStDate("yesterday")).toBeNull()
    expect(parseStDate(`${"9".repeat(100)}`)).toBeNull()
  })
})

describe("ST chat parts", () => {
  it("reads the header, swipes, reasoning, hidden messages, speakers and summaries", () => {
    const { part, report } = read(
      lines(
        {
          chat_metadata: {
            note_prompt: "Be brief.",
            note_position: 1,
            note_depth: 2,
            note_role: 1,
            note_interval: 3,
            variables: { mood: "calm" },
            world_info: "Hollow",
            main_chat: "Alice - first",
            persona: "user.png"
          },
          user_name: "unused",
          character_name: "unused"
        },
        {
          name: "Alice",
          is_user: false,
          mes: "Hi.",
          send_date: "2025-01-01T10:00:00.000Z",
          swipes: ["Hey.", "Hi."],
          swipe_id: 1,
          swipe_info: [{ send_date: "2025-01-01T09:00:00.000Z", extra: { reasoning: "first" } }, {}],
          extra: { reasoning: "second" }
        },
        {
          name: "Sam",
          is_user: true,
          is_system: true,
          mes: "Hello.",
          force_avatar: "User Avatars/user.png",
          extra: { memory: "They met." }
        },
        { name: "Bob", mes: "Yo.", original_avatar: "Bob.png", extra: { type: "narrator" } }
      )
    )
    expect(report.issues).toEqual([])
    expect(part.header).toMatchObject({
      mainChat: "Alice - first",
      persona: "user.png",
      world: "Hollow",
      authorNote: { content: "Be brief.", position: 1, depth: 2, role: 1, interval: 3 },
      variablesJson: JSON.stringify([["mood", "calm"]])
    })
    const [greeting, user, narrator] = messages(part.batches)
    expect(greeting).toEqual({
      user: false,
      hidden: false,
      speaker: "c:name:Alice",
      selected: 1,
      versions: [
        { content: "Hey.", reasoning: "first", at: Date.UTC(2025, 0, 1, 9) },
        { content: "Hi.", reasoning: "second", at: Date.UTC(2025, 0, 1, 10) }
      ]
    })
    // No date: the one before it, so a re-import gives it the same time.
    expect(user).toMatchObject({
      user: true,
      hidden: true,
      speaker: "u:avatar:user.png",
      versions: [{ at: Date.UTC(2025, 0, 1, 10) }]
    })
    expect(narrator!.speaker).toBeNull()
    expect(part).toMatchObject({
      messages: 3,
      userTurns: 1,
      leadingHidden: 0,
      greeting: "Hi.",
      summaries: [{ index: 1, text: "They met." }]
    })
    expect(part.speakers.map((s) => s.key)).toEqual(["c:name:Alice", "u:avatar:user.png"])
  })

  it("keeps the shown text when it isn't among the swipes, and reads thumbnail avatars", () => {
    const { part } = read(
      lines(
        { chat_metadata: {} },
        {
          name: "A",
          mes: "edited",
          swipes: ["one", "two"],
          swipe_id: 0,
          force_avatar: "/thumbnail?type=avatar&file=A%20b.png"
        }
      )
    )
    const [message] = messages(part.batches)
    expect(message!.versions.map((v) => v.content)).toEqual(["one", "two", "edited"])
    expect(message!.selected).toBe(2)
    expect(part.speakers[0]!.avatar).toBe("A b.png")
  })

  it("counts leading hidden messages, skips unreadable lines and continues indices across parts", () => {
    const { part, report } = read(
      lines(
        { mes: "a", is_system: true },
        "not json",
        { mes: "b", is_system: true },
        { mes: "c" },
        { mes: "d", is_system: true }
      ),
      false,
      40,
      5
    )
    expect(part).toMatchObject({ header: null, messages: 4, leadingHidden: 2, greeting: null })
    expect(messages(part.batches)[0]!.versions[0]!.at).toBe(5)
    expect(report.issues.map((i) => i.code)).toEqual(["st_chat.unreadable_lines"])
  })

  it("reads a headerless chat (an old group chat) from its first line", () => {
    const { part } = read(lines({ mes: "first", name: "A" }))
    expect(part.header).toBeNull()
    expect(part.messages).toBe(1)
  })

  it("splits messages into batches of a transaction's worth", () => {
    const many = Array.from({ length: stChatLimits.maxBatchMessages * 2 + 1 }, (_, i) => ({ mes: `m${i}` }))
    const { part } = read(lines({ chat_metadata: {} }, ...many))
    expect(part.batches.map((b) => JSON.parse(b.messagesJson).length)).toEqual([
      stChatLimits.maxBatchMessages,
      stChatLimits.maxBatchMessages,
      1
    ])
  })

  it("refuses a part over the cap", () => {
    expect(() => read(new Uint8Array(stChatLimits.maxPartBytes + 1))).toThrow(FormatError)
  })

  it("caps swipes and variables, and drops prototype keys", () => {
    const { part, report } = read(
      lines(
        {
          chat_metadata: {
            variables: Object.fromEntries(Array.from({ length: stChatLimits.maxVariables + 1 }, (_, i) => [`v${i}`, i]))
          }
        },
        `{"mes": "x", "swipes": ${JSON.stringify(Array.from({ length: stChatLimits.maxSwipes + 5 }, (_, i) => `s${i}`))}, "__proto__": {"polluted": true}}`
      )
    )
    expect(JSON.parse(part.header!.variablesJson)).toHaveLength(stChatLimits.maxVariables)
    expect(messages(part.batches)[0]!.versions).toHaveLength(stChatLimits.maxSwipes + 1)
    expect(report.issues.map((i) => i.code).sort()).toEqual(
      ["json.forbidden_key", "st_chat.swipes_dropped", "st_chat.variables_dropped"].sort()
    )
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it("refuses an oversized variable value", () => {
    const { part, report } = read(
      lines({ chat_metadata: { variables: { big: "x".repeat(stChatLimits.maxVariableBytes + 1), small: 1 } } })
    )
    expect(JSON.parse(part.header!.variablesJson)).toEqual([["small", 1]])
    expect(report.issues.map((i) => i.code)).toEqual(["st_chat.variable_too_large"])
  })
})

describe("ST settings and groups", () => {
  it("reads personas, lorebooks, the notes and the summary settings, and nothing else", () => {
    const issues = new ReportBuilder()
    const settings = parseStSettings(
      new TextEncoder().encode(
        JSON.stringify({
          power_user: {
            personas: { "a.png": "Ann" },
            persona_descriptions: {
              "a.png": { description: "Ann.", position: 4, depth: 1, role: 2 },
              "b.png": { description: "No name." }
            }
          },
          world_info_settings: {
            world_info: { globalSelect: ["W"], charLore: [{ name: "Alice", extraBooks: ["X"] }] }
          },
          extension_settings: {
            memory: { position: -1, depth: 5, role: 1, template: "S: {{summary}}" },
            note: {
              default: "Default note.",
              defaultPosition: 0,
              defaultDepth: 3,
              defaultRole: 2,
              defaultInterval: 2,
              chara: [{ name: "Alice", prompt: "x", useChara: true }],
              allowWIScan: true
            },
            disabledExtensions: ["memory"]
          },
          secret_field: "never read"
        })
      ),
      issues
    )
    expect(settings).toEqual({
      selectedPreset: null,
      defaultPersona: null,
      personas: [
        { avatar: "a.png", name: "Ann", description: "Ann.", position: 4, depth: 1, role: 2 },
        { avatar: "b.png", name: "", description: "No name.", position: 0, depth: 2, role: 0 }
      ],
      globalWorlds: ["W"],
      characterWorlds: [{ card: "Alice", worlds: ["X"] }],
      defaultAuthorNote: { content: "Default note.", position: 0, depth: 3, role: 2, interval: 2 },
      // ST's position defaults to 0 (replace) when a character's note has none.
      characterNotes: [{ card: "Alice", prompt: "x", useChara: true, position: 0 }],
      allowWIScan: true,
      summary: {
        prompt: null,
        promptWords: 200,
        position: -1,
        depth: 5,
        role: 1,
        template: "S: {{summary}}",
        enabled: false
      }
    })
    expect(issues.build("x").issues.map((i) => i.code)).toEqual([])
  })

  it("reads a group's members, muted members and chats", () => {
    const group = parseStGroup(
      new TextEncoder().encode(
        JSON.stringify({
          id: "g",
          name: "G",
          members: ["a.png", 3],
          disabled_members: ["a.png"],
          chats: ["c1"],
          chat_id: "c2"
        })
      ),
      "g.json",
      new ReportBuilder()
    )
    // `chat_id` is the chat ST opens the group on: the one last opened.
    expect(group).toEqual({
      id: "g",
      name: "G",
      members: ["a.png"],
      disabledMembers: ["a.png"],
      chats: ["c1", "c2"],
      chatId: "c2"
    })
  })
})

it("an unreadable chat part cannot change the selected persona", () => {
  const part = unreadChatPart(new Uint8Array(), null)
  expect(part.userTurns).toBe(0)
  expect(part.lastUserSpeaker).toBeNull()
})

// What an ST import's report says, and what it brings that the report's links and names read
// (importreport, 2026-11-02): a warning about what rode on a chat's author's note only for the
// chats where something did, each issue linked to its chat, a chat's start from its first
// message, and a group's reply strategy. Everything here is synthetic.
import { assert, layer } from "@effect/vitest"
import type { ChatId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { card, encode, header, jsonl, message } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

/** ST's author's note keys in a chat's metadata (`authors-note.js`). */
const note = (prompt: string, depth: number, interval = 1) => ({
  note_prompt: prompt,
  note_position: 1,
  note_depth: depth,
  note_role: 0,
  note_interval: interval
})

const say = (name: string, mes: string, minute: number, user = false) =>
  message({ name, mes, minute, user, ...(user ? { persona: "user.png" } : {}) })

/**
 * A folder where things ride on author's notes in only some places: Cleo has a Character
 * Author's Note ST doesn't use (`useChara` off), Dax one it does and a book with an entry at the
 * note, and the persona's description is in the prompt. The default author's note is at depth 4;
 * every chat's own at depth 2.
 */
const folder = () =>
  new Map<string, Uint8Array>(
    (
      [
        [
          "settings.json",
          encode({
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
                chara: [
                  { name: "Cleo", prompt: "Cleo whistles.", useChara: false, position: 1 },
                  { name: "Dax", prompt: "Dax squints.", useChara: true, position: 1 }
                ]
              },
              disabledExtensions: []
            }
          })
        ],
        ["characters/Cleo.png", card("Cleo", "Hello.")],
        ["characters/Dax.png", card("Dax", "Hm.", { world: "Signs" })],
        [
          "worlds/Signs.json",
          encode({
            entries: {
              "1": {
                uid: 1,
                key: [],
                keysecondary: [],
                comment: "sign",
                content: "A sign creaks.",
                constant: true,
                selective: false,
                order: 100,
                position: 2,
                disable: false,
                depth: 4,
                role: 0,
                probability: 100,
                useProbability: false
              }
            }
          })
        ],
        [
          "chats/Cleo/Cleo - a.jsonl",
          jsonl([header(note("Rain.", 2)), say("Cleo", "Hello.", 0), say("Sam", "Hi.", 1, true)])
        ],
        // Named by an ST stamp years before its first message, as ST names a card's first chat
        // after the card's `chat` field; no header date, so it starts at its first message.
        [
          "chats/Cleo/2024-9-10 @13h 44m 41s 16ms.jsonl",
          jsonl([header({}), say("Cleo", "Hello.", 20), say("Sam", "Again.", 21, true), say("Cleo", "Yes?", 22)])
        ],
        [
          "chats/Dax/Dax - a.jsonl",
          jsonl([header(note("Dust.", 2)), say("Dax", "Hm.", 0), say("Sam", "Hi.", 1, true)])
        ],
        // Its note is off (frequency 0): ST sent nothing at it.
        [
          "chats/Dax/Dax - quiet.jsonl",
          jsonl([header(note("Hush.", 2, 0)), say("Dax", "Hm.", 0), say("Sam", "Hi.", 1, true)])
        ],
        [
          "groups/solo.json",
          encode({
            id: "solo",
            name: "Cleos",
            members: ["Cleo.png"],
            disabled_members: [],
            chats: ["Cleos - 1"],
            activation_strategy: 3
          })
        ],
        [
          "groups/both.json",
          encode({
            id: "both",
            name: "Both",
            members: ["Cleo.png", "Dax.png"],
            disabled_members: [],
            chats: ["Both - 1"]
          })
        ],
        [
          "group chats/Cleos - 1.jsonl",
          jsonl([
            header(note("Wind.", 2)),
            message({ name: "Cleo", mes: "Hello.", minute: 0, avatar: "Cleo.png" }),
            say("Sam", "Hi.", 1, true)
          ])
        ],
        [
          "group chats/Both - 1.jsonl",
          jsonl([
            header(note("Crowd.", 2)),
            message({ name: "Dax", mes: "Hm.", minute: 0, avatar: "Dax.png" }),
            say("Sam", "Hi.", 1, true)
          ])
        ]
      ] as const
    ).map(([path, bytes]) => [`data/default-user/${path}`, bytes])
  )

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "180 seconds" })("ST import report", (it) => {
  it.effect("warns only where something rode on the chat's own author's note, linking each chat", () =>
    Effect.gen(function* () {
      const { report } = yield* importStFolder(folder())
      const riders = report.issues.filter((issue) => issue.code === "st.author_note_riders")
      // Not Cleo's chats (her note is unused, the persona is in the prompt), not the quiet one,
      // not the group of Cleo alone: Dax's own note in his one-to-one chat, and his book in the
      // group he's in (a card's own note is off in a group chat).
      assert.deepStrictEqual(riders.map((issue) => issue.path).sort(), [
        "chats/Dax/Dax - a.jsonl",
        "group chats/Both - 1.jsonl"
      ])
      // One message, said once in the report, and what's particular to each chat beside it.
      assert.strictEqual(new Set(riders.map((issue) => issue.message)).size, 1)
      const dax = riders.find((issue) => issue.path === "chats/Dax/Dax - a.jsonl")!
      assert.strictEqual(
        dax.detail,
        "Dax's own author's note; the lorebook “Signs”'s entries at the note. This chat's note: depth 2 as system; the default's: depth 4 as system."
      )
      assert.strictEqual(
        riders.find((issue) => issue.path === "group chats/Both - 1.jsonl")!.detail,
        "the lorebook “Signs”'s entries at the note. This chat's note: depth 2 as system; the default's: depth 4 as system."
      )
      // Each links to the chat it went into.
      const api = yield* client()
      for (const issue of riders) {
        assert.isDefined(issue.chatId)
        yield* api.GetChat({ chatId: issue.chatId! })
      }
      assert.strictEqual(report.dropped, 0)
    })
  )

  it.effect("starts a chat at its first message, and its group's reply strategy comes with it", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const user = yield* api.Whoami()
      const chats = yield* api.ListChats({ limit: 500, before: null })
      const stamped = chats.find((chat) => chat.title === "2024-9-10 @13h 44m 41s 16ms")!
      // No header date: its first message's time (10:20), not its last's, nor the file name's.
      assert.strictEqual(stamped.createdAt, Date.UTC(2025, 0, 1, 10, 20))
      const castOf = (chatId: ChatId) =>
        Effect.gen(function* () {
          const leaf = (yield* api.GetChat({ chatId })).activeLeafSlotId
          return yield* api.GetCast({ chatId, slotId: leaf })
        })
      const pooled = chats.find((chat) => chat.title.startsWith("Cleos"))!
      assert.strictEqual((yield* castOf(pooled.id)).replyOrder, "pooled")
      // ST's default, natural order, isn't written down.
      const both = chats.find((chat) => chat.title.startsWith("Both"))!
      assert.isUndefined((yield* castOf(both.id)).replyOrder)
      // ST groups reply in rounds: they import with "One reply at a time" off (DESIGN §2.3).
      assert.isUndefined((yield* castOf(pooled.id)).replySingle)
      assert.isUndefined((yield* castOf(both.id)).replySingle)
      // The latest chat, as the report's Continue names it: its start and its characters.
      const latest = yield* (yield* Reader).StImportLatestChat({ userId: user.id })
      assert.isNotNull(latest)
      assert.strictEqual(latest!.createdAt, chats.find((chat) => chat.id === latest!.chatId)!.createdAt)
      assert.isArray(latest!.names)
      assert.isAbove(latest!.names.length, 0)
    })
  )
})

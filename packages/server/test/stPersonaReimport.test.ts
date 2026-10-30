import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { serverLayer, testConfig } from "./support/config.ts"
import { card, encode, header, jsonl, message } from "./support/stFolder.ts"
import { png } from "./formats/support.ts"
import { importStFolder } from "./support/stUpload.ts"

const config = testConfig()
const chat = (id: string) =>
  jsonl([
    header({ note_prompt: "Synthetic AN", note_interval: 0 }),
    message({ name: "Aria", mes: "Synthetic greeting " + id, minute: 0 }),
    message({ name: "Sam", mes: "Synthetic user turn " + id, user: true, minute: 1, persona: "sam.png" })
  ])
const folder = (names: string[]) =>
  new Map<string, Uint8Array>([
    [
      "settings.json",
      encode({
        username: "Sam",
        user_avatar: "sam.png",
        power_user: {
          personas: { "sam.png": "Sam" },
          default_persona: "sam.png",
          persona_descriptions: { "sam.png": { description: "SYNTHETIC PERSONA NOTE", position: 2, depth: 4, role: 0 } }
        },
        extension_settings: {
          note: { default: "", defaultPosition: 1, defaultDepth: 4, defaultRole: 0, defaultInterval: 1 }
        }
      })
    ],
    ["User Avatars/sam.png", png()],
    ["characters/Aria.png", card("Aria", "Synthetic greeting")],
    ...names.map((name): [string, Uint8Array] => ["chats/Aria/" + name + ".jsonl", chat(name)])
  ])
layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })("ST persona note re-import", (it) => {
  it.effect("unchanged persona must stay disabled in newly added frequency-zero chats", () =>
    Effect.gen(function* () {
      const first = yield* importStFolder(folder(["first"]))
      const firstChat = (yield* first.api.ListChats({ limit: 100, before: null })).find((c) => c.title === "first")!
      const before = yield* first.api.ListChatNotes({ chatId: firstChat.id, slotId: null })
      const noteBefore = before.find((n) => n.doc["content"] === "SYNTHETIC PERSONA NOTE")!
      assert.isDefined(noteBefore)
      assert.isFalse(noteBefore.active, "control: first import disables persona note")
      const second = yield* importStFolder(folder(["first", "second"]))
      const newChat = (yield* second.api.ListChats({ limit: 100, before: null })).find((c) => c.title === "second")!
      const after = yield* second.api.ListChatNotes({ chatId: newChat.id, slotId: null })
      const noteAfter = after.find((n) => n.doc["content"] === "SYNTHETIC PERSONA NOTE")!
      assert.strictEqual(second.report.counts.persona?.unchanged, 1)
      assert.isFalse(noteAfter.active, "same persona note must remain off in a new frequency-zero chat")
    })
  )
})

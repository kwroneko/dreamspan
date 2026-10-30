// Synthetic folder import: persona selection never changes the authors of old messages.
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { encode, header, jsonl, message, card } from "./support/stFolder.ts"
import { png } from "./formats/support.ts"
import { importStFolder } from "./support/stUpload.ts"

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "180 seconds" })(
  "imported persona selection",
  (it) => {
    it.effect("uses the locked or default persona when no user-side message exists", () =>
      Effect.gen(function* () {
        const api = yield* client()
        const files = new Map<string, Uint8Array>([
          [
            "settings.json",
            encode({ power_user: { personas: { "a.png": "Ada", "b.png": "Bo" }, default_persona: "b.png" } })
          ],
          ["User Avatars/a.png", png()],
          ["User Avatars/b.png", png()],
          ["characters/Bot.png", card("Bot", "Hello.")]
        ])
        for (const [name, metadata] of [
          ["Locked", { persona: "a.png" }],
          ["Default", {}]
        ] as const) {
          files.set(
            `chats/Bot/${name}.jsonl`,
            jsonl([
              header(metadata),
              message({ name: "Bot", mes: "First", minute: 1 }),
              message({ name: "Bot", mes: "Second", minute: 2 })
            ])
          )
        }
        const { answers } = yield* importStFolder(files, { prefix: "", partBytes: 200 })
        assert.isFalse([...answers.values()].some((r) => r.outcome === "failed"))
        const chats = yield* api.ListChats({ limit: 100, before: null })
        for (const [title, name] of [
          ["Locked", "Ada"],
          ["Default", "Bo"]
        ]) {
          const chat = chats.find((c) => c.title === title)!
          const cast = yield* api.GetCast({ chatId: chat.id, slotId: null })
          const persona = cast.cards.find((c) => c.name === name)
          assert.isDefined(persona, `${title} should include ${name}`)
          assert.deepStrictEqual(cast.playedByMe, [persona.entityId])
          assert.include(cast.participants, persona.entityId)
          assert.strictEqual(cast.macroNames.user, name)
        }
      })
    )

    it.effect("selects the last persona by name or avatar in single and group chats", () =>
      Effect.gen(function* () {
        const api = yield* client()
        const files = new Map<string, Uint8Array>([
          [
            "settings.json",
            encode({ power_user: { personas: { "a.png": "Ada", "b.png": "Bo" }, default_persona: "a.png" } })
          ],
          ["User Avatars/a.png", png()],
          ["User Avatars/b.png", png()],
          ["characters/Bot.png", card("Bot", "Hello.")],
          ["groups/g.json", encode({ id: "g", name: "Group", members: ["Bot.png"], chats: ["group"] })]
        ])
        for (const path of ["chats/Bot/single.jsonl", "group chats/group.jsonl"]) {
          files.set(
            path,
            jsonl([
              header({ persona: "a.png" }),
              message({ name: "Ada", user: true, mes: "First", minute: 1, persona: "a.png" }),
              message({ name: "Bo", user: true, mes: "Second", minute: 2 }),
              message({ name: "Bot", mes: "Reply", minute: 3 })
            ])
          )
        }
        const { answers } = yield* importStFolder(files, { prefix: "", partBytes: 200 })
        assert.isFalse([...answers.values()].some((r) => r.outcome === "failed"))
        const user = yield* api.Whoami()
        const sources = yield* (yield* Reader).StImportSources({ userId: user.id })
        const records = sources.chats.filter((r) => /\/(single|group)\.jsonl$/.test(r.source))
        for (const record of records) {
          const cast = yield* api.GetCast({ chatId: record.chatId, slotId: null, forkId: record.forkId })
          const ada = cast.cards.find((c) => c.name === "Ada")!.entityId
          const bo = cast.cards.find((c) => c.name === "Bo")!.entityId
          assert.deepStrictEqual(cast.playedByMe, [bo])
          assert.strictEqual(cast.macroNames.user, "Bo")
          assert.include(cast.participants, ada)
          const path = yield* api.ReadPath({
            chatId: record.chatId,
            forkId: record.forkId,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 100
          })
          assert.deepStrictEqual(
            path.entries.slice(0, 2).map((e) => e.version.speakerEntityId),
            [ada, bo]
          )
        }
        assert.lengthOf(records, 2)
      })
    )
  }
)

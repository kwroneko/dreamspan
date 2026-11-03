// Synthetic ST groups only: default names, renamed groups and user-named chat files.
import { assert, layer } from "@effect/vitest"
import { chatName } from "@rp/shared/chatName.ts"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { card, encode, header, jsonl, message } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

const cases = [
  { id: "default", group: "Group: Cleo, Dax", file: "2024-08-25@03h30m53s", name: "Cleo, Dax", minute: 10 },
  { id: "renamed", group: "The expedition", file: "2024-8-26 @03h 30m 53s 12ms", name: "The expedition", minute: 20 },
  { id: "named", group: "The expedition", file: "Before the duel", name: "Before the duel", minute: 30 },
  // A renamed group can have the same name as one member without becoming automatic.
  { id: "character", group: "Cleo", file: "2024-08-27@03h30m53s123ms", name: "Cleo", minute: 40 },
  { id: "mismatch", group: "Group: Other", file: "2024-08-28@03h30m53s", name: "Group: Other", minute: 50 }
]

const folder = () => {
  const files = new Map<string, Uint8Array>([
    ["characters/Cleo.png", card("Cleo", "Hello.")],
    ["characters/Dax.png", card("Dax", "Hello.")]
  ])
  for (const row of cases) {
    files.set(
      `groups/${row.id}.json`,
      encode({
        id: row.id,
        name: row.group,
        // ST builds the default name in character-list order, not member order.
        members: ["Dax.png", "Cleo.png"],
        chats: [row.file],
        chat_id: row.file
      })
    )
    files.set(
      `group chats/${row.file}.jsonl`,
      jsonl([
        // Exercise both header creation dates and the first-message fallback.
        { ...header({}), ...(row.id === "default" ? { create_date: "2026-04-20T06:36:00Z" } : {}) },
        message({ name: "Cleo", mes: "Hello.", minute: row.minute, avatar: "Cleo.png" }),
        message({ name: "Sam", mes: "Let's go.", minute: row.minute + 1, user: true }),
        message({ name: "Dax", mes: "Ready.", minute: row.minute + 2, avatar: "Dax.png" })
      ])
    )
  }
  return files
}

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "180 seconds" })("ST group titles", (it) => {
  it.effect("uses characters or a renamed group with the start date, and keeps user-named files", () =>
    Effect.gen(function* () {
      const { report } = yield* importStFolder(folder())
      assert.isFalse(report.issues.some((issue) => issue.level === "error"))
      const api = yield* client()
      const user = yield* api.Whoami()
      const records = (yield* (yield* Reader).StImportSources({ userId: user.id })).chats
      for (const row of cases) {
        const source = records.find((record) => record.source === `group chats/${row.file}.jsonl`)!
        assert.isDefined(source, row.id)
        const chat = yield* api.GetChat({ chatId: source.chatId })
        const cast = yield* api.GetCast({ chatId: chat.id, slotId: chat.activeLeafSlotId })
        const characters = cast.cards.filter(
          (card) => cast.participants.includes(card.entityId) && !cast.playedByMe.includes(card.entityId)
        )
        const expectedAt = row.id === "default" ? Date.UTC(2026, 3, 20, 6, 36) : Date.UTC(2025, 0, 1, 10, row.minute)
        assert.strictEqual(chat.createdAt, expectedAt)
        const name = chatName(chat.title, characters, chat.createdAt)
        // Automatic names use the cast's order, just as character chats do.
        assert.strictEqual(name.name, row.id === "default" ? characters.map((card) => card.name).join(", ") : row.name)
        assert.deepStrictEqual(name.started, row.id === "named" ? null : new Date(expectedAt))
        if (row.id === "named") assert.strictEqual(chat.title, row.file)
        const shell = yield* api.GetShellForks({
          entity: null,
          chat: chat.id,
          search: "",
          sort: "recent",
          sections: [
            { id: "peers", limit: 50 },
            { id: "other", limit: 50 }
          ]
        })
        const rows = shell.sections.flatMap((section) => section.rows).filter((fork) => fork.chat.id === chat.id)
        assert.isAbove(rows.length, 0)
        assert.deepStrictEqual(
          rows.map((fork) => fork.chatName),
          // Shell casts follow participant order; GetCast.cards follows library order.
          rows.map(() => (row.id === "default" ? "Dax, Cleo" : row.name)),
          row.id
        )
      }
      // Re-importing after the group was renamed in ST doesn't repair an existing title.
      const existing = records.find((record) => record.source === `group chats/${cases[0]!.file}.jsonl`)!
      const before = yield* api.GetChat({ chatId: existing.chatId })
      const changed = folder()
      changed.set(
        "groups/default.json",
        encode({
          id: "default",
          name: "A later name",
          members: ["Cleo.png", "Dax.png"],
          chats: [cases[0]!.file]
        })
      )
      yield* importStFolder(changed)
      assert.strictEqual((yield* api.GetChat({ chatId: existing.chatId })).title, before.title)
    })
  )
})

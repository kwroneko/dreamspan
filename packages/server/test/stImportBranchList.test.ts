// What an imported ST branch family looks like in the branch lists (owner, 2026-11-01): the chat
// opens on the file ST last opened (a group's `chat_id`, a card's `chat`), else on the branch
// with the latest message; no fork is named after its file; the chat is named by its group or
// root chat, never a branch file; each fork says where it splits off and when its last message is.
import { assert, layer } from "@effect/vitest"
import type { ChatId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { card, encode, header, jsonl, message } from "./support/stFolder.ts"
import { importStFolder, sendStFile } from "./support/stUpload.ts"

const config = testConfig()
const minute = (m: number) => Date.UTC(2025, 0, 1, 10, m)

const B1 = "Branch #2 - 2025-01-12@21h40m51s"
const B2 = "Branch #3 - 2025-01-13@08h00m00s"
const lines = (who: string, me: string, own: ReadonlyArray<[string, number]>) => [
  message({ name: who, mes: `${who} says hello.`, minute: 0 }),
  message({ name: me, user: true, mes: "Hello.", minute: 1 }),
  message({ name: who, mes: "Shall we?", minute: 2 }),
  ...own.map(([mes, m], i) => message({ name: i % 2 ? who : me, user: i % 2 === 0, mes, minute: m }))
]

/** A main chat and two branches of it at its third message, the second with the latest message. */
const family = (dir: string, main: string, who: string) =>
  new Map<string, Uint8Array>([
    [`${dir}/${main}.jsonl`, jsonl([header({}), ...lines(who, "Sam", [["Main goes on.", 3]])])],
    [
      `${dir}/${B1}.jsonl`,
      jsonl([
        header({ main_chat: main }),
        ...lines(who, "Sam", [
          ["First branch.", 10],
          ["It answers.", 11]
        ])
      ])
    ],
    [`${dir}/${B2}.jsonl`, jsonl([header({ main_chat: main }), ...lines(who, "Sam", [["Second branch.", 20]])])]
  ])

const forksOf = Effect.fnUntraced(function* (chatId: ChatId) {
  const api = yield* client()
  const user = yield* api.Whoami()
  const records = (yield* (yield* Reader).StImportSources({ userId: user.id })).chats.filter((r) => r.chatId === chatId)
  const bySource = new Map(records.map((r) => [r.source.replace(/^.*\//, "").replace(/\.jsonl$/, ""), r.forkId]))
  const shell = yield* api.GetShellForks({
    entity: null,
    chat: chatId,
    search: "",
    sort: "recent",
    sections: [
      { id: "peers", limit: 50 },
      { id: "other", limit: 50 }
    ]
  })
  const rows = shell.sections.flatMap((s) => s.rows)
  const listed = yield* api.ListForks({ chatId })
  const chat = yield* api.GetChat({ chatId })
  const of = (file: string) => {
    const id = bySource.get(file)!
    return { row: rows.find((r) => r.forkId === id)!, fork: listed.find((f) => f.id === id)! }
  }
  return { chat, rows, listed, of, current: [...bySource].find(([, id]) => id === chat.currentForkId)?.[0] }
})

const chatTitled = Effect.fnUntraced(function* (prefix: string) {
  const api = yield* client()
  return (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title.startsWith(prefix))!
})

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })("ST branch families", (it) => {
  it.effect("a group chat opens on its chat_id's branch, named by the group, its forks unnamed", () =>
    Effect.gen(function* () {
      const files = new Map([
        ["characters/Misaka.png", card("Misaka", "Hi.")],
        ["characters/Kuroko.png", card("Kuroko", "Hi.")],
        [
          "groups/g1.json",
          encode({
            id: "g1",
            name: "Misaka Mikoto",
            members: ["Misaka.png", "Kuroko.png"],
            chats: ["2025-1-1@10h00m00s000ms", B1, B2],
            chat_id: B1
          })
        ],
        ...family("group chats", "2025-1-1@10h00m00s000ms", "Misaka")
      ])
      yield* importStFolder(files)
      const chat = yield* chatTitled("Misaka Mikoto")
      assert.strictEqual(chat.title, "Misaka Mikoto: 2025-1-1@10h00m00s000ms")
      const { of, current, rows, listed } = yield* forksOf(chat.id)
      assert.strictEqual(current, B1)
      assert.lengthOf(rows, 3)
      assert.isTrue(rows.every((r) => !r.named && r.chatName === "Misaka Mikoto"))
      assert.isTrue(listed.every((f) => f.name === null))
      // Where each splits off: after the three messages they share, at its first own message.
      const main = of("2025-1-1@10h00m00s000ms")
      assert.isTrue(main.row.original)
      assert.isNull(main.row.split)
      assert.deepStrictEqual(of(B1).row.split, { at: minute(10), after: 3 })
      assert.deepStrictEqual(of(B1).fork.split, { at: minute(10), after: 3 })
      assert.deepStrictEqual(of(B2).row.split, { at: minute(20), after: 3 })
      // Each one's last message, from ST, never the import's time.
      assert.strictEqual(of(B1).row.endAt, minute(11))
      assert.strictEqual(of(B1).fork.endAt, minute(11))
      assert.strictEqual(main.row.endAt, minute(3))
      // By last message, newest first.
      assert.deepStrictEqual(
        rows.map((r) => r.endAt),
        [minute(20), minute(11), minute(3)]
      )
    })
  )

  it.effect("a solo chat opens on the card's chat field; without a match, on the latest message", () =>
    Effect.gen(function* () {
      const root = "Bot - 2025-1-1@10h00m00s000ms"
      const other = "Ann - 2025-1-1@10h00m00s000ms"
      const files = new Map([
        ["characters/Bot.png", card("Bot", "Hi.", {}, {}, { chat: B1 })],
        // Ann's card names a chat the folder doesn't have.
        ["characters/Ann.png", card("Ann", "Hi.", {}, {}, { chat: "Ann - gone" })],
        ...family("chats/Bot", root, "Bot"),
        ...family("chats/Ann", other, "Ann")
      ])
      yield* importStFolder(files)
      const bot = yield* chatTitled("Bot - ")
      assert.strictEqual(bot.title, root)
      assert.strictEqual((yield* forksOf(bot.id)).current, B1)
      const ann = yield* chatTitled("Ann - ")
      const annForks = yield* forksOf(ann.id)
      assert.strictEqual(annForks.current, B2)

      // Chatting in a branch makes it the user's: importing the folder again keeps it.
      const api = yield* client()
      const mainFork = annForks.of(other).fork
      const tip = (yield* api.ReadPath({
        chatId: ann.id,
        forkId: mainFork.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 10
      })).entries.at(-1)!
      yield* posted(
        api.SendMessage({
          chatId: ann.id,
          forkId: mainFork.id,
          parentSlotId: tip.slotId,
          branch: false,
          content: "I'm back."
        })
      )
      assert.strictEqual((yield* forksOf(ann.id)).current, other)
      yield* importStFolder(files)
      assert.strictEqual((yield* forksOf(ann.id)).current, other)
    })
  )

  it.effect("an orphan branch's chat is named by its main chat, not the branch file", () =>
    Effect.gen(function* () {
      const root = "Cat - 2025-1-1@10h00m00s000ms"
      const files = new Map([
        ["characters/Cat.png", card("Cat", "Hi.")],
        [`chats/Cat/${B1}.jsonl`, family("chats/Cat", root, "Cat").get(`chats/Cat/${B1}.jsonl`)!]
      ])
      const api = yield* client()
      const { importId } = yield* api.StartStImport({ unsupported: [] })
      const answer = yield* sendStFile(importId, `chats/Cat/${B1}.jsonl`, files.get(`chats/Cat/${B1}.jsonl`)!, {
        card: "none",
        orphan: "1"
      })
      assert.notInclude(["failed", "deferred"], answer.outcome)
      const chat = yield* chatTitled("Cat - ")
      assert.strictEqual(chat.title, root)
    })
  )
})

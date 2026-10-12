import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, testConfig, withServer, typeInto } from "./support/config.ts"
import { sendStFile } from "./support/stUpload.ts"
it.live("re-import appending to a chat carries its saved composer", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const path = "chats/N5/import.jsonl"
    const message = (content: string, n: number) => ({
      name: n % 2 ? "User" : "Bot",
      is_user: n % 2 === 1,
      mes: content,
      send_date: 1730000000000 + n
    })
    const file = (more: boolean) =>
      new TextEncoder().encode(
        [
          { chat_metadata: {} },
          message("Greeting", 0),
          message("Human", 1),
          ...(more ? [message("Imported continuation", 2)] : [])
        ]
          .map((x) => JSON.stringify(x))
          .join("\n")
      )
    const first = yield* api.StartStImport({ unsupported: [] })
    yield* sendStFile(first.importId, path, file(false), { card: "none" })
    const chat = (yield* api.ListChats({ limit: 10, before: null }))[0]!
    const d = yield* typeInto(api, chat.id, chat.activeLeafSlotId, "SAVED WHILE REIMPORT ARRIVES")
    const second = yield* api.StartStImport({ unsupported: [] })
    const result = yield* sendStFile(second.importId, path, file(true), { card: "none" })
    const moved = yield* api.GetChat({ chatId: chat.id })
    const c = yield* api.OpenComposer({ chatId: chat.id, tipSlotId: moved.activeLeafSlotId })
    console.log(
      "IMPORT_HTTP",
      JSON.stringify({
        result,
        oldTip: chat.activeLeafSlotId,
        newTip: moved.activeLeafSlotId,
        draftAtNewTip: c,
        oldDraft: d
      })
    )
    assert.strictEqual(c.content, d.content)
  }).pipe(Effect.scoped, withServer(testConfig()))
)

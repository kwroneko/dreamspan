// Paged library reads (spec/WORKSHOP-CARDS.md §4.3 point 2): read_card, read_lorebook and
// read_preset give a small item whole as before, a large one as its summary, and page a field, a
// greeting, a book's index and one entry, each page saying where to read on. Synthetic items only.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Chat, SlotId, VersionId } from "@dreamspan/shared/chat.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { libraryTools } from "../src/agent/tools/library.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"

const entity = (
  writer: Writer["Service"],
  userId: string,
  kind: "card" | "lorebook",
  label: string,
  doc: { readonly schema_version: number }
) =>
  Effect.map(
    writer.CreateEntity({
      userId: userId as never,
      kind,
      label,
      subtitle: "",
      doc: doc as never,
      schemaVersion: doc.schema_version,
      origin: "user",
      sourcePath: null
    }),
    ({ ref }) => ref
  )

describe("paged library reads", () => {
  it.live("read whole when small, by summary, field, greeting, index and entry when large", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const me = yield* api.Whoami()
      const chat: Chat = yield* api.CreateWorkshop({})
      const writer = yield* Writer
      const context: ToolContext = {
        userId: me.id,
        chatId: chat.id,
        forkId: chat.currentForkId,
        slotId: chat.activeLeafSlotId as SlotId,
        versionId: "unused" as VersionId,
        rolloutId: "unused",
        toolCallId: "unused",
        leafSlotId: null,
        reader: yield* Reader,
        writer,
        viewers: null,
        cache: new Map()
      }
      const run = (name: string, args: unknown) =>
        libraryTools.find((t) => t.id === name)!.execute(context, args as never)

      // Small: whole, as before.
      const small = yield* api.CreateCard({ label: "Wren", name: "Wren", description: "Keeps the light." })
      const whole = yield* run("read_card", { card: small.id })
      assert.strictEqual(JSON.parse(whole.text).doc.description, "Keeps the light.")

      // Large: a summary by default, and "whole" refused with it.
      const lines = Array.from({ length: 4000 }, (_, i) => `Shelf ${i + 1} holds charts of the coast.`)
      const large = yield* entity(
        writer,
        me.id,
        "card",
        "Archive",
        cardDoc("Archive", {
          description: lines.join("\n"),
          alternate_greetings: ["The door creaks.", "A lamp flickers."]
        })
      )
      const summary = yield* run("read_card", { card: large.id })
      assert.isUndefined(summary.isError)
      assert.include(summary.text, 'card "Archive"')
      assert.match(summary.text, /description: [\d,]+ tokens, 4,000 lines/)
      assert.include(summary.text, "alternate_greetings: 2")
      assert.notInclude(summary.text, "Shelf 2 holds")
      const refused = yield* run("read_card", { card: large.id, view: "whole" })
      assert.include(refused.text, "Too long to read whole: read it by field.")

      // A field in pages, cut at line ends, read on from each offset to the end.
      const first = yield* run("read_card", { card: large.id, view: "field", field: "description", max_tokens: 500 })
      assert.include(first.text, "Shelf 1 holds charts of the coast.")
      const next = /Read on with offset=(\d+)\.\]/.exec(first.text)
      assert.isNotNull(next)
      const offset = Number(next![1])
      assert.strictEqual(lines.join("\n")[offset - 1], "\n")
      let text = first.text.slice(first.text.indexOf(":\n") + 2, first.text.lastIndexOf("\n["))
      let at: number | null = offset
      for (let pages = 0; at !== null && pages < 200; pages++) {
        const page = yield* run("read_card", {
          card: large.id,
          view: "field",
          field: "description",
          offset: at,
          max_tokens: 8000
        })
        text += page.text.slice(page.text.indexOf(":\n") + 2, page.text.lastIndexOf("\n["))
        const on = /Read on with offset=(\d+)\.\]/.exec(page.text)
        if (on === null) assert.include(page.text, "That's the end.]")
        at = on === null ? null : Number(on[1])
      }
      assert.strictEqual(text, lines.join("\n"))

      // An alternate greeting, from 1; a field that isn't one is refused.
      const greeting = yield* run("read_card", {
        card: large.id,
        view: "field",
        field: "alternate_greetings",
        greeting: 2
      })
      assert.include(greeting.text, "A lamp flickers.")
      assert.isTrue((yield* run("read_card", { card: large.id, view: "field", field: "nope" })).isError)

      // A lorebook's index pages 50 entries at a time; one entry reads with its settings.
      const book = yield* entity(
        writer,
        me.id,
        "lorebook",
        "Harbor",
        loreBook(
          Array.from({ length: 60 }, (_, i) =>
            loreEntry({ comment: `Pier ${i + 1}`, content: `Boats tie up at pier ${i + 1}.` }, i + 1)
          )
        ).document
      )
      const index = yield* run("read_lorebook", { lorebook: book.id, view: "index" })
      assert.include(index.text, "- Pier 1 (uid")
      assert.notInclude(index.text, "Pier 51 (")
      const after = /Remaining after this page: 10\. Read on with after="([^"]+)"\./.exec(index.text)
      assert.isNotNull(after)
      const rest = yield* run("read_lorebook", { lorebook: book.id, view: "index", after: after![1] })
      assert.include(rest.text, "Pier 60 (")
      assert.include(rest.text, "60 in all; that's the end.")
      const uid = /- Pier 3 \(uid (\d+)/.exec(index.text)![1]
      const entry = yield* run("read_lorebook", { lorebook: book.id, view: "entry", entry: Number(uid) })
      assert.include(entry.text, '"comment":"Pier 3"')
      assert.include(entry.text, "Boats tie up at pier 3.")
      assert.isTrue((yield* run("read_lorebook", { lorebook: book.id, view: "entry", entry: 99999 })).isError)

      // A preset's prompts in order, and one by identifier.
      const preset = yield* api.CreatePreset({ label: "Plain" })
      const prompts = yield* run("read_preset", { preset: preset.id, view: "index" })
      assert.match(prompts.text, /- .+ \(main; (on|off)\): [\d,]+ tokens/)
      const main = yield* run("read_preset", { preset: preset.id, view: "prompt", prompt: "main" })
      assert.isUndefined(main.isError)
      assert.include(main.text, "prompt main:")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

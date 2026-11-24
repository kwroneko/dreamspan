// export_to_file (spec/WORKSHOP-CARDS.md §4.3 point 2, unit C2c): a card's field, a lorebook
// entry, a preset prompt or a whole item written to the working folder through the file tools'
// own path: the folder, never replacing a file, quota, an undoable change, the Files capability,
// and the library classes for what's outside view. Synthetic items only.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { SlotId, VersionId } from "@dreamspan/shared/chat.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import type { FrozenTool, ToolContext } from "../src/agent/tools.ts"
import { FILE_TOOLS } from "../src/agent/tools/files.ts"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { cardDoc, presetDoc } from "./support/docs.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

describe("export_to_file", () => {
  it.live(
    "writes a field, an entry, a prompt or a whole item to the working folder, undoably",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const api = yield* client()
        const me = yield* api.Whoami()
        const writer = yield* Writer
        const chat = yield* api.CreateWorkshop({ title: "Exports" })
        const port = yield* serverPort
        const made = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${port}/files/folder`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: "/files/notes" })
          })
        )
        assert.strictEqual(made.status, 200)
        yield* api.ChangeCast({
          chatId: chat.id,
          slotId: null,
          change: { _tag: "WorkshopFolder", path: "/files/notes" }
        })
        const rolloutId = `r-${chat.id}`
        yield* fixtureSql(config.dataDir, [
          {
            sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES (?,?,'workshop','running','assistant','interactive',1,1)",
            params: [rolloutId, chat.id]
          }
        ])
        const registry = yield* ExecutionRegistry
        const base: ToolContext = {
          userId: me.id,
          chatId: chat.id,
          forkId: chat.currentForkId,
          leafSlotId: null,
          slotId: chat.activeLeafSlotId as SlotId,
          versionId: "unused" as VersionId,
          rolloutId,
          toolCallId: "x",
          reader: yield* Reader,
          writer,
          viewers: null,
          cache: new Map()
        }
        let calls = 0
        const run = (name: string, args: unknown, context: Partial<ToolContext> = {}) =>
          toolForKind(registry, "workshop", name)!.execute(
            { ...base, toolCallId: `${name}-${++calls}`, ...context },
            args as never
          )
        const create = (
          kind: "card" | "lorebook" | "preset",
          label: string,
          doc: { readonly schema_version: number }
        ) =>
          Effect.map(
            writer.CreateEntity({
              userId: me.id,
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

        // Offered exactly where write_file is: one of the file tools, under the same capability.
        assert.include(FILE_TOOLS, "export_to_file")
        const tool = toolForKind(registry, "workshop", "export_to_file")!
        assert.strictEqual(tool.capability, toolForKind(registry, "workshop", "write_file")!.capability)

        const description = Array.from({ length: 3000 }, (_, i) => `Shelf ${i + 1} holds charts of the coast.`).join(
          "\n"
        )
        const card = yield* create(
          "card",
          "Mara Quill",
          cardDoc("Mara Quill", { description, alternate_greetings: ["The door creaks.", "A lamp flickers."] })
        )

        // A field, to the working folder, named after the item, the exact text.
        const field = yield* run("export_to_file", { kind: "card", item: card.id, field: "description" })
        assert.isUndefined(field.isError, field.text)
        assert.include(field.text, "/files/notes/Mara Quill description.txt")
        assert.include(field.text, "3,000 lines")
        const back = yield* run("read_file", { path: "/files/notes/Mara Quill description.txt", limit: 20_000 })
        assert.include(back.text, "Shelf 3000 holds charts of the coast.")
        assert.strictEqual(field.effects?.[0]?.kind, "file.create")

        // The same again never replaces it: a taken name gets (2).
        const again = yield* run("export_to_file", { kind: "card", item: "Mara Quill", field: "description" })
        assert.include(again.text, "/files/notes/Mara Quill description (2).txt")

        // A greeting, and the whole card as JSON (without its skills), at a path given.
        const greeting = yield* run("export_to_file", {
          kind: "card",
          item: card.id,
          field: "alternate_greetings",
          greeting: 2
        })
        assert.include(greeting.text, "Mara Quill alternate greeting 2.txt")
        const whole = yield* run("export_to_file", { kind: "card", item: card.id, path: "out/mara.json" })
        assert.include(whole.text, "/files/notes/out/mara.json")
        const json = yield* run("read_file", { path: "/files/notes/out/mara.json", limit: 20_000 })
        assert.include(json.text, '"name": "Mara Quill"')

        // A lorebook entry and a preset prompt.
        const book = yield* create(
          "lorebook",
          "Harbour lore",
          loreBook([loreEntry({ comment: "Pier", content: "Boats tie up at the pier." }, 7)]).document
        )
        const entry = yield* run("export_to_file", { kind: "lorebook", item: book.id, entry: 7 })
        assert.include(entry.text, "/files/notes/Harbour lore entry 7.txt")
        assert.include(
          (yield* run("read_file", { path: "/files/notes/Harbour lore entry 7.txt" })).text,
          "Boats tie up at the pier."
        )
        const preset = yield* create(
          "preset",
          "Prose",
          presetDoc([{ identifier: "main", content: "Write vivid prose." }])
        )
        const prompt = yield* run("export_to_file", { kind: "preset", item: preset.id, prompt: "main" })
        assert.include(prompt.text, "Prose prompt main.txt")

        // An earlier revision, by number.
        const head = yield* base.reader.GetRef({ userId: me.id, refId: card.id })
        yield* writer.EditRef({
          userId: me.id,
          refId: card.id,
          expectedRowVersion: head.ref.rowVersion,
          doc: { ...head.doc, description: "Rewritten." },
          message: null,
          commitDraft: null
        })
        const old = yield* run("export_to_file", {
          kind: "card",
          item: card.id,
          field: "description",
          revision: "1",
          path: "old.txt"
        })
        assert.isUndefined(old.isError, old.text)
        assert.include((yield* run("read_file", { path: "/files/notes/old.txt", limit: 20_000 })).text, "Shelf 3000")

        // Wrong targets name the choices; nothing is written.
        assert.include(
          (yield* run("export_to_file", { kind: "card", item: card.id, field: "nope" })).text,
          "Give field, one of"
        )
        assert.include(
          (yield* run("export_to_file", { kind: "lorebook", item: book.id, entry: 99 })).text,
          "No entry 99"
        )
        // Outside a writable root it's refused as write_file refuses it.
        assert.include(
          (yield* run("export_to_file", { kind: "card", item: card.id, path: "/app-source/x.txt" })).text,
          "read-only"
        )

        // Outside view, the library class decides first: declined, nothing written.
        const declined = yield* run(
          "export_to_file",
          { kind: "card", item: card.id, path: "declined.txt" },
          {
            sight: {
              inView: () => Effect.succeed(false),
              gate: () => Effect.succeed({ ok: false as const, text: "The user declined." })
            }
          }
        )
        assert.strictEqual(declined.text, "The user declined.")
        assert.isTrue((yield* run("read_file", { path: "/files/notes/declined.txt" })).isError)

        // The quota holds it as it holds write_file.
        yield* api.SetFilesQuota({ userId: me.id, quotaBytes: 0 })
        const over = yield* run("export_to_file", { kind: "card", item: card.id, path: "over.txt" })
        assert.isTrue(over.isError)
        yield* api.SetFilesQuota({ userId: me.id, quotaBytes: null })

        // Undo takes the new file away.
        yield* writer.RecordRolloutEffects({
          userId: me.id,
          rolloutId,
          toolCallId: "export",
          result: field.text,
          isError: false,
          effects: field.effects ?? []
        })
        const effect = (yield* api.ListRolloutEffects({ chatId: chat.id })).find((e) => e.toolCallId === "export")!
        yield* api.UndoRolloutEffect({ rolloutId, toolCallId: "export", seq: effect.seq })
        assert.isTrue((yield* run("read_file", { path: "/files/notes/Mara Quill description.txt" })).isError)

        // Files turned off in this workshop: refused like every file tool.
        yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "files", mode: "off" })
        const off = yield* run("export_to_file", { kind: "card", item: card.id, path: "off.txt" })
        assert.include(off.text, "off in this workshop")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    },
    120_000
  )

  it.live("a long read points to export_to_file only where the run offers it", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const me = yield* api.Whoami()
      const chat = yield* api.CreateWorkshop({})
      const writer = yield* Writer
      const registry = yield* ExecutionRegistry
      const base: ToolContext = {
        userId: me.id,
        chatId: chat.id,
        forkId: chat.currentForkId,
        leafSlotId: null,
        slotId: chat.activeLeafSlotId as SlotId,
        versionId: "unused" as VersionId,
        rolloutId: "unused",
        toolCallId: "unused",
        reader: yield* Reader,
        writer,
        viewers: null,
        cache: new Map()
      }
      const { ref } = yield* writer.CreateEntity({
        userId: me.id,
        kind: "card",
        label: "Archive",
        subtitle: "",
        doc: cardDoc("Archive", {
          description: Array.from({ length: 3000 }, (_, i) => `Shelf ${i + 1}.`).join("\n")
        }) as never,
        schemaVersion: cardDoc("Archive").schema_version,
        origin: "user",
        sourcePath: null
      })
      const offer = (names: ReadonlyArray<string>) => ({
        kind: "workshop",
        tools: names.map((name) => ({ name }) as FrozenTool),
        loaded: new Set<string>()
      })
      const read = (context: Partial<ToolContext>, args: unknown) =>
        toolForKind(registry, "workshop", "read_card")!.execute({ ...base, ...context } as ToolContext, args as never)
      const page = { card: ref.id, view: "field", field: "description", max_tokens: 200 }
      const offered = yield* read({ offer: offer(["read_card", "export_to_file"]) as never }, page)
      assert.include(offered.text, "save it to a file with export_to_file")
      const summary = yield* read({ offer: offer(["read_card", "export_to_file"]) as never }, { card: ref.id })
      assert.include(summary.text, "export_to_file")
      const without = yield* read({ offer: offer(["read_card"]) as never }, page)
      assert.notInclude(without.text, "export_to_file")
      // A page that is the whole field says nothing.
      const short = yield* read(
        { offer: offer(["read_card", "export_to_file"]) as never },
        {
          ...page,
          max_tokens: 8000,
          offset: 30_000
        }
      )
      assert.notInclude(short.text, "export_to_file")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

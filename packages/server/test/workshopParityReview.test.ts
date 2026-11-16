// Review of the notes and files tools (review-wsb3): what each consent covers, what the user is
// shown before allowing a call, open tabs after a change and its Undo, paging a chat's notes,
// grouped Undo, a finished folder import through the tool, and the file import's limits.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { SlotId, VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { toolData, TOOL_RESULT_CHARS } from "../src/agent/toolData.ts"
import { workshopCapabilities } from "../src/agent/capabilities.ts"
import { client, serverLayer, testConfig, outcome } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { stFolder } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

const UUID = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/

const fixture = (dataDir: string) =>
  Effect.gen(function* () {
    const api = yield* client()
    const user = yield* api.Whoami()
    const chat = yield* api.CreateWorkshop({})
    const rolloutId = `op-${chat.id}`
    yield* fixtureSql(dataDir, [
      {
        sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES (?,?,'workshop','running','assistant','interactive',1,1)",
        params: [rolloutId, chat.id]
      }
    ])
    const reader = yield* Reader
    const writer = yield* Writer
    const registry = yield* ExecutionRegistry
    const context: ToolContext = {
      userId: user.id,
      chatId: chat.id,
      forkId: chat.currentForkId,
      slotId: chat.activeLeafSlotId as SlotId,
      versionId: "unused" as VersionId,
      rolloutId,
      toolCallId: "unused",
      leafSlotId: null,
      viewers: null,
      reader,
      writer,
      cache: new Map()
    }
    const tool = (name: string) => toolForKind(registry, "workshop", name)!
    const run = (name: string, args: unknown, id = name) =>
      tool(name).execute({ ...context, toolCallId: id }, args as never)
    const ok = (name: string, args: unknown, id = name) =>
      Effect.map(run(name, args, id), (out) => {
        assert.isUndefined(out.isError, `${id}: ${out.text}`)
        return Object.assign(JSON.parse(out.text) as Record<string, unknown>, { _out: out })
      })
    const describeCall = (name: string, args: unknown, id: string) =>
      tool(name).describe!({ ...context, toolCallId: id, cache: new Map() }, args as never)
    const effects = () => api.ListRolloutEffects({ chatId: chat.id })
    const effectOf = (id: string) =>
      Effect.map(effects(), (all) => {
        const found = all.find((e) => e.toolCallId === id)
        assert.isDefined(found, `no effect for ${id}`)
        return found!
      })
    const undo = (id: string) => Effect.flatMap(effectOf(id), (effect) => api.UndoRolloutEffect(effect))
    const allow = (capability: string) =>
      writer.SetWorkshopGrant({ userId: user.id, chatId: chat.id, capability, mode: "allow" })
    return {
      api,
      user,
      chat,
      rolloutId,
      reader,
      writer,
      registry,
      run,
      ok,
      describeCall,
      effects,
      effectOf,
      undo,
      allow
    }
  })

/** The chat open in a tab: every event it is sent from now on. */
const openTab = (api: Effect.Success<ReturnType<typeof client>>, chatId: string) =>
  Effect.gen(function* () {
    const seen: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chatId as never }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => seen.push(...batch))),
      Effect.forkScoped
    )
    const deadline = Date.now() + 10_000
    while (seen.length === 0 && Date.now() < deadline) yield* Effect.sleep(10)
    const states = () => seen.filter((e) => e._tag === "State").length
    /** Waits briefly for a State event, as a tab would get one. */
    const heard = Effect.gen(function* () {
      const until = Date.now() + 2_000
      while (states() === 0 && Date.now() < until) yield* Effect.sleep(10)
      const count = states()
      seen.splice(0)
      return count
    })
    seen.splice(0)
    return { heard }
  })

const story = (api: Effect.Success<ReturnType<typeof client>>, title: string) =>
  Effect.gen(function* () {
    const made = yield* api.CreateChat({ title })
    yield* api.SendMessage({ chatId: made.id, parentSlotId: null, branch: false, content: "A synthetic opening." })
    return yield* api.GetChat({ chatId: made.id })
  })

describe("notes and files tools: review", () => {
  it("each capability's explanation names what its new tools touch", () => {
    const says = (id: string) => workshopCapabilities.get(id)!.explanation.toLowerCase()
    // Read your library: the shared and card notes read_note and list_shared_notes read.
    assert.include(says("library.read"), "notes")
    // Create and edit library items: notes, the bin, a file's import, personas.
    for (const word of ["notes", "bin", "import", "persona"]) assert.include(says("library.write"), word)
    // Set up chats: a chat's notes, made and switched.
    assert.include(says("chats.setup"), "notes")
    // Read your chats: a chat's notes and folder imports' reports.
    for (const word of ["notes", "import"]) assert.include(says("chats.read"), word)
  })

  it.live("approvals name the note and the chat, never an id", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const s = yield* story(f.api, "Lighthouse story")
      const note = yield* f.api.CreateChatNote({ chatId: s.id, title: "Weather", content: "Fog." })
      const shown = (prompt: { title: string; rows: ReadonlyArray<{ label: string; value: string }> }) => {
        assert.notMatch(prompt.title, UUID, prompt.title)
        for (const row of prompt.rows) {
          assert.notMatch(row.value, UUID, `${row.label}: ${row.value}`)
          assert.notInclude(["chatId", "forkId", "slotId", "change"], row.label)
        }
        return prompt
      }
      const made = shown(yield* f.describeCall("create_chat_note", { chat: s.id, title: "Tide", content: "Low." }, "a"))
      assert.include(made.title, "Tide")
      assert.include(made.title, "Lighthouse story")
      const read = shown(yield* f.describeCall("list_chat_notes", { chat: s.id }, "b"))
      assert.include(read.title, "Lighthouse story")
      const switched = shown(
        yield* f.describeCall("change_chat", { chat: s.id, change: { _tag: "Note", note: note.id, active: true } }, "c")
      )
      assert.include(switched.title, "Weather")
      assert.include(switched.title, "Lighthouse story")
      // Other changes keep the existing description.
      const renamed = yield* f.describeCall(
        "change_chat",
        { chat: s.id, change: { _tag: "ReplyOrder", order: "natural" } },
        "d"
      )
      assert.isAbove(renamed.rows.length, 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("open chats hear of a note made, binned or taken back by the assistant", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      yield* f.allow("chats.read")
      const s = yield* story(f.api, "Open story")
      // The story is open in a tab.
      const tab = yield* openTab(f.api, s.id)
      yield* f.ok("create_chat_note", { chat: s.id, title: "Scene" }, "made")
      assert.isAbove(yield* tab.heard, 0, "a chat note made by a tool reaches the open story")
      yield* f.undo("made")
      assert.isAbove(yield* tab.heard, 0, "its Undo reaches the open story")

      const shared = yield* f.api.CreateSharedNote({ title: "House rules", content: "Quiet after dark." })
      yield* tab.heard
      yield* f.ok("delete_note", { note: shared.id }, "binned")
      assert.isAbove(yield* tab.heard, 0, "a binned shared note reaches the open story")
      yield* f.undo("binned")
      assert.isAbove(yield* tab.heard, 0, "taking it back out of the bin reaches the open story")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a chat's notes page within what the model sees, and a long one reads whole", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      yield* f.allow("chats.read")
      const s = yield* story(f.api, "Many notes")
      const made = new Set<string>()
      for (let n = 0; n < 12; n++) {
        const text = `Note ${n}: ${'"quoted" & <marked> '.repeat(150)}`
        made.add((yield* f.api.CreateChatNote({ chatId: s.id, title: `Note ${n}`, content: text })).id)
      }
      const long = `${"A long chat note. ".repeat(500)}THE END`
      const longNote = yield* f.api.CreateChatNote({ chatId: s.id, title: "Long", content: long })
      made.add(longNote.id)
      const seen = new Set<string>()
      let offset: number | null = 0
      for (let page = 0; offset !== null && page < 20; page++) {
        const listed = yield* f.ok("list_chat_notes", { chat: s.id, offset }, `page-${page}`)
        // Everything a page lists fits the quoted result the model is sent.
        assert.isAtMost(toolData(listed._out.text, listed._out.frame).length, TOOL_RESULT_CHARS, `page ${page}`)
        for (const entry of listed.entries as Array<{ id: string }>) {
          assert.isFalse(seen.has(entry.id), `overlap at ${entry.id}`)
          seen.add(entry.id)
        }
        offset = listed.nextOffset as number | null
      }
      assert.deepStrictEqual([...seen].sort(), [...made].sort())
      // One note by itself comes whole.
      const one = yield* f.ok("list_chat_notes", { chat: s.id, note: longNote.id }, "one")
      const entries = one.entries as Array<{ id: string; content: string; contentCut?: boolean }>
      assert.lengthOf(entries, 1)
      assert.strictEqual(entries[0]!.content, long)
      assert.isUndefined(entries[0]!.contentCut)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("binning names the note, says what shows it, and grouped Undo puts everything back", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const card = yield* f.api.CreateCard({ label: "Mira", name: "Mira" })
      // The user's own shared note, shown by the user's card note.
      const shared = yield* f.api.CreateSharedNote({ title: "Harbour rules", content: "Boats in by dusk." })
      const slot = yield* f.api.CreateCardNote({ cardRefId: card.id, title: "Rules", link: shared.entityId })
      const asked = yield* f.describeCall("delete_note", { note: shared.id }, "ask")
      assert.include(JSON.stringify(asked.rows), "1")
      assert.match(JSON.stringify(asked.rows), /note/i)
      yield* f.ok("delete_note", { note: shared.id }, "bin-user-note")
      assert.include((yield* f.effectOf("bin-user-note")).title, "Harbour rules")
      yield* f.undo("bin-user-note")
      const back = yield* f.api.OpenEditor({ refId: slot.id })
      assert.strictEqual(back.doc.link, shared.entityId)
      assert.strictEqual((yield* f.api.OpenEditor({ refId: shared.id })).doc.content, "Boats in by dusk.")

      // One reply: make a shared note, link a card note to it, edit it, then bin it. Undo all.
      const s = yield* story(f.api, "Harbour")
      yield* f.allow("chats.read")
      const made = yield* f.ok("create_shared_note", { title: "Tides", content: "Twice a day." }, "r-make")
      const linked = yield* f.ok("create_card_note", { card: card.id, title: "Tides", shared_note: made.id }, "r-link")
      yield* f.ok("edit_library_note", { note: made.id, content: "Twice a day, mostly." }, "r-edit")
      yield* f.ok("delete_note", { note: made.id }, "r-bin")
      const all = yield* f.api.UndoRolloutEffects({ chatId: f.chat.id, rolloutId: f.rolloutId })
      assert.isNull(all.refused, JSON.stringify(all.refused))
      assert.strictEqual(yield* outcome(f.api.OpenEditor({ refId: made.id as never })), "NotFound")
      assert.strictEqual(yield* outcome(f.api.OpenEditor({ refId: linked.id as never })), "NotFound")
      // The user's own notes are as they were.
      assert.strictEqual((yield* f.api.OpenEditor({ refId: slot.id })).doc.link, shared.entityId)
      assert.isDefined(s)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a finished folder import's report reads through the tool, a page at a time", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      yield* f.allow("chats.read")
      yield* importStFolder(stFolder())
      const jobs = yield* f.api.ListStImports()
      assert.lengthOf(jobs, 1)
      const listed = yield* f.ok("list_imports", {}, "jobs")
      const entry = (listed.entries as Array<{ id: string; status: string; counts: unknown }>)[0]!
      assert.strictEqual(entry.id, jobs[0]!.id)
      assert.strictEqual(entry.status, jobs[0]!.status)
      const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown
      assert.deepStrictEqual(entry.counts, plain(jobs[0]!.counts))
      assert.notInclude(listed._out.text, jobs[0]!.source === "" ? "\u0000" : jobs[0]!.source)
      const report = yield* f.api.GetStImportReport({ importId: entry.id as never })
      const issues: Array<unknown> = []
      let offset: number | null = 0
      for (let page = 0; offset !== null && page < 50; page++) {
        const read = yield* f.ok("read_import", { import: entry.id, offset, limit: 2 }, `report-${page}`)
        assert.deepStrictEqual(read.counts, plain(report.counts))
        issues.push(...(read.entries as Array<unknown>))
        offset = read.nextOffset as number | null
      }
      assert.strictEqual(issues.length, report.issues.length)
      assert.deepStrictEqual(
        issues.map((i) => (i as { code: string }).code),
        report.issues.map((i) => i.code)
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a file import takes JSON text only, within the size limit, and approves nothing", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const before = (yield* f.api.ListLibrary({ kind: "card", archived: false })).length
      // A zip's or a picture's bytes as text, and an oversized file: refused, nothing saved.
      for (const [id, content] of [
        ["zip", "PK\u0003\u0004" + "x".repeat(200)],
        ["png", "\u0089PNG\r\n\u001a\n" + "x".repeat(200)],
        ["huge", JSON.stringify({ spec: "chara_card_v2", data: { name: "Huge", description: "x".repeat(70_000) } })]
      ] as const) {
        const out = yield* f.run("import_library_file", { name: `${id}.json`, content }, id)
        assert.isTrue(out.isError === true || JSON.parse(out.text).imported === false, `${id}: ${out.text}`)
      }
      // Paths are names only; the text given is the only source.
      for (const name of ["/etc/hostname", "C:\\Windows\\win.ini", "../../../../etc/passwd"]) {
        const out = yield* f.run("import_library_file", { name, content: "not json" }, `path-${name.length}`)
        assert.isTrue(out.isError === true || JSON.parse(out.text).imported === false, `${name}: ${out.text}`)
      }
      assert.lengthOf(yield* f.api.ListLibrary({ kind: "card", archived: false }), before)
      // A card's own regex scripts arrive unapproved.
      const card = JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: "Scripted",
          description: "Synthetic.",
          first_mes: "Hello.",
          extensions: {
            regex_scripts: [
              {
                id: "synthetic-script",
                scriptName: "Swap a for b",
                findRegex: "/a/g",
                replaceString: "b",
                trimStrings: [],
                placement: [2],
                disabled: false,
                markdownOnly: false,
                promptOnly: false,
                runOnEdit: true,
                substituteRegex: 0,
                minDepth: null,
                maxDepth: null
              }
            ],
            rp_harness: { regex_approved: true, html_scripts_approved: true }
          }
        }
      })
      const imported = yield* f.ok("import_library_file", { name: "scripted.json", content: card }, "scripted")
      const doc = (yield* f.api.OpenEditor({ refId: imported.id as never })).doc as Record<string, unknown>
      assert.notStrictEqual(doc.regex_approved, true)
      assert.notStrictEqual(doc.html_scripts_approved, true)
      assert.lengthOf(doc.regex as ReadonlyArray<unknown>, 1, "the scripts themselves are kept")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

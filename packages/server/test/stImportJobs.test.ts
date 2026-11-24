// ST folder imports as server-side jobs (ARCHITECTURE.md §13): a path import runs to its end
// with no client calls after it starts, its row (status, counts, report) is kept and listed,
// a notice tells the user's tabs, a cancel stops it at a file boundary, clearing removes only
// finished jobs, and a job still running when the server stopped is interrupted at the next
// start. Uploads get a job too. Every file is synthetic (support/stFolder.ts); listing only
// the caller's jobs is in the isolation matrix.
import { mkdirSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { dirname, join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { vi } from "vitest"
import type { Notice } from "@dreamspan/shared/noticeApi.ts"
import { classifyStPath } from "@dreamspan/shared/stFolder.ts"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { Writer } from "../src/db/Database.ts"
import { databaseFile } from "../src/db/connection.ts"
import { Report } from "../src/importer/stReport.ts"
import { StImports } from "../src/importer/StImports.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { card, encode, header, jsonl, message, stFolder } from "./support/stFolder.ts"
import { jobEnded, sendFile, sendStFile } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"

const onDisk = (files: ReadonlyMap<string, Uint8Array>) => {
  const root = tempDir("st-jobs")
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), bytes)
  }
  return root
}

/** A folder of `count` small chats, so a job takes a while file by file. */
const manyChats = (count: number) =>
  new Map<string, Uint8Array>([
    ["characters/Nobody.png", card("Nobody", "Hi.")],
    ...Array.from({ length: count }, (_, i): [string, Uint8Array] => [
      `chats/Nobody/Chat ${String(i).padStart(4, "0")}.jsonl`,
      jsonl([
        header({}),
        message({ name: "Sam", user: true, mes: `Hello ${i}.`, minute: 0 }),
        message({ name: "Nobody", mes: `Hi ${i}.`, minute: 1 })
      ])
    ])
  ])

/** The job's row as the database has it, read without the server. */
const row = (dataDir: string, id: string) => {
  const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
  try {
    return db
      .prepare("SELECT status, files_done, files_total, report_json FROM st_import_jobs WHERE id = ?")
      .get(id) as { status: string; files_done: number; files_total: number; report_json: string | null } | undefined
  } finally {
    db.close()
  }
}

const until = (check: () => boolean, ms = 120_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("timed out waiting"))
      yield* Effect.sleep(20)
    }
  })

describe("ST import jobs", () => {
  it.live("re-imports a folder after its default persona is refiled", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const root = onDisk(stFolder())
      const api = yield* client()
      const writer = yield* Writer
      const { id: userId } = yield* api.Whoami()
      const run = () =>
        Effect.gen(function* () {
          const { importId } = yield* api.StartStPathImport({ path: root, prefix: "" })
          yield* until(() => (row(config.dataDir, importId)?.status ?? "running") !== "running")
          const { job } = yield* api.GetStImport({ importId })
          assert.strictEqual(job.status, "complete")
          assert.strictEqual(job.filesDone, job.filesTotal)
        })
      yield* run()
      const { persona } = yield* api.GetGenerationDefaults()
      assert.isNotNull(persona)
      yield* writer.SetEntityTags({ userId, entityId: persona!, tags: [] })

      const alternate = (yield* api.CreateCard({ label: "Alternate", name: "Alternate" })).entityId
      yield* writer.SetEntityTags({ userId, entityId: alternate, tags: ["persona"] })
      yield* api.ChangeGenerationDefaults({ change: { persona: alternate } })
      yield* run()
      assert.strictEqual((yield* api.GetGenerationDefaults()).persona, alternate)

      yield* api.ChangeGenerationDefaults({ change: { persona: null } })
      yield* run()
      assert.isNull((yield* api.GetGenerationDefaults()).persona)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live(
    "a path import runs to its end with no client calls after it starts, and is kept and listed",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const root = onDisk(stFolder("data/default-user/"))
        // The browser that started it goes away at once.
        const importId = yield* Effect.scoped(
          Effect.gen(function* () {
            const api = yield* client()
            return (yield* api.StartStPathImport({ path: root, prefix: "data/default-user/" })).importId
          })
        )
        yield* until(() => row(config.dataDir, importId)?.status === "complete")
        const api = yield* client()
        const [job] = yield* api.ListStImports()
        assert.strictEqual(job!.id, importId)
        assert.strictEqual(job!.status, "complete")
        assert.strictEqual(job!.mode, "path")
        assert.strictEqual(job!.filesDone, job!.filesTotal)
        assert.strictEqual(job!.counts.card?.added, 6)
        assert.strictEqual(job!.counts.chat?.added, 4)
        assert.isNotNull(job!.finishedAt)
        assert.isFalse(job!.seen)
        // At least the chat to link: what the user must act on.
        assert.isAtLeast(job!.attention, 1)
        const detail = yield* api.GetStImport({ importId })
        assert.deepStrictEqual(
          detail.report!.links.map((choice) => choice.path),
          ["chats/Twin/Twin - who.jsonl"]
        )
        yield* api.SeenStImport({ importId })
        assert.isTrue((yield* api.GetStImport({ importId })).job.seen)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    },
    180_000
  )

  it.live(
    "the preview tells what's already here, the report counts groups and names the latest imported chat",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const files = stFolder("data/default-user/")
        const root = onDisk(files)
        const api = yield* client()
        const paths = [...files.keys()].map((path) => path.slice("data/default-user/".length))
        const added = "chats/Nobody/Later.jsonl"
        assert.deepStrictEqual((yield* api.StImportPreview({ paths })).known, [])
        const { importId } = yield* api.StartStPathImport({ path: root, prefix: "data/default-user/" })
        yield* until(() => row(config.dataDir, importId)?.status === "complete")
        const known = new Set((yield* api.StImportPreview({ paths: [...paths, added] })).known)
        // Cards, personas, lorebooks, presets and finished chats are here; a file never imported isn't.
        for (const path of paths) {
          const kind = classifyStPath(path)?.kind
          if (kind === "card" || kind === "persona_avatar" || kind === "world" || kind === "preset")
            assert.isTrue(known.has(path), path)
          if (kind === "settings" || kind === "group") assert.isFalse(known.has(path), path)
        }
        assert.isTrue([...known].some((path) => path.startsWith("chats/")))
        assert.isFalse(known.has(added))
        // Read from the folder: a copy of an imported lorebook under another name is here, as
        // the import finds it by its bytes, and a chat of only a greeting is one no import takes.
        const user = join(root, "data/default-user")
        writeFileSync(join(user, "worlds/Hollow copy.json"), files.get("data/default-user/worlds/Hollow.json")!)
        mkdirSync(join(user, "chats/Nobody"), { recursive: true })
        writeFileSync(
          join(user, "chats/Nobody/Hi.jsonl"),
          jsonl([header({}), message({ name: "Nobody", mes: "Hi.", minute: 0 })])
        )
        writeFileSync(
          join(user, added),
          jsonl([header({}), message({ name: "Sam", user: true, mes: "Hey.", minute: 0 })])
        )
        const read = yield* api.StImportPreview({
          paths: ["worlds/Hollow copy.json", "chats/Nobody/Hi.jsonl", added],
          folder: { root, prefix: "data/default-user/" }
        })
        assert.deepStrictEqual(read.known, ["worlds/Hollow copy.json"])
        assert.deepStrictEqual(read.skipped, ["chats/Nobody/Hi.jsonl"])
        const detail = yield* api.GetStImport({ importId })
        assert.isAtLeast(detail.report!.counts.group?.unchanged ?? 0, 1)
        assert.isAtLeast(detail.report!.counts.persona?.added ?? 0, 1)
        assert.isNotNull(detail.latestChat)
        // The chat list's newest, as every chat here came from the import.
        const [newest] = yield* api.ListChats({ limit: 1, before: null })
        assert.strictEqual(detail.latestChat!.chatId, newest!.id)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    },
    180_000
  )

  it.live(
    "publishes progress and the end, cancels at a file boundary, and clears only finished jobs",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const api = yield* client()
        const notices: Array<Notice> = []
        yield* api.SubscribeNotices().pipe(
          Stream.runForEach((batch) =>
            Effect.sync(() => notices.push(...batch.filter((notice) => notice._tag === "StImportChanged")))
          ),
          Effect.forkScoped
        )
        yield* api.Whoami()

        // A finished job, and a long one.
        const small = yield* api.StartStPathImport({
          path: onDisk(new Map([["settings.json", encode({})]])),
          prefix: ""
        })
        yield* jobEnded(api, small.importId)
        const long = yield* api.StartStPathImport({ path: onDisk(manyChats(400)), prefix: "" })
        // One import at a time.
        const busy = yield* Effect.flip(api.StartStPathImport({ path: onDisk(manyChats(1)), prefix: "" }))
        assert.strictEqual(busy._tag, "StImportBusy")
        const upload = yield* Effect.flip(api.StartStImport({ unsupported: [] }))
        assert.strictEqual(upload._tag, "StImportBusy")

        // Clearing leaves the running job alone.
        assert.strictEqual((yield* api.ClearStImports({ importId: null })).cleared, 1)
        assert.deepStrictEqual(
          (yield* api.ListStImports()).map((job) => job.id),
          [long.importId]
        )
        assert.strictEqual((yield* api.ClearStImports({ importId: long.importId })).cleared, 0)

        yield* until(() => (row(config.dataDir, long.importId)?.files_done ?? 0) > 0)
        yield* api.CancelStImport({ importId: long.importId })
        const cancelled = yield* jobEnded(api, long.importId)
        assert.strictEqual(cancelled.job.status, "cancelled")
        assert.isBelow(cancelled.job.filesDone, cancelled.job.filesTotal)
        assert.isAbove(cancelled.job.filesDone, 0)
        // What it imported before it stopped is in its report.
        assert.isAbove(cancelled.report!.counts.chat?.added ?? 0, 0)

        yield* until(() =>
          notices.some(
            (notice) =>
              notice._tag === "StImportChanged" && notice.importId === long.importId && notice.status === "cancelled"
          )
        )
        const mine = notices.filter((notice) => notice._tag === "StImportChanged" && notice.importId === long.importId)
        assert.strictEqual(mine[0]!._tag === "StImportChanged" && mine[0]!.status, "running")
        assert.isTrue(
          notices.some(
            (notice) =>
              notice._tag === "StImportChanged" && notice.importId === small.importId && notice.status === "complete"
          )
        )

        assert.strictEqual((yield* api.ClearStImports({ importId: long.importId })).cleared, 1)
        assert.lengthOf(yield* api.ListStImports(), 0)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    },
    180_000
  )

  it.live(
    "an upload's job records its files as they arrive, and ends when the browser says so",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const api = yield* client()
        const files = [...stFolder()].filter(([path]) => {
          const kind = classifyStPath(path)?.kind
          return kind !== undefined && kind !== "unsupported" && kind !== "chat" && kind !== "group_chat"
        })
        const bytes = files.reduce((sum, [, file]) => sum + file.byteLength, 0)
        const { importId } = yield* api.StartStImport({ unsupported: [], source: "ST", files: files.length, bytes })
        for (const [path, file] of files) yield* sendStFile(importId, path, file)
        const running = yield* api.GetStImport({ importId })
        assert.strictEqual(running.job.status, "running")
        assert.strictEqual(running.job.mode, "upload")
        assert.strictEqual(running.job.source, "ST")
        yield* api.FinishStImport({
          importId,
          notSent: [{ path: "chats/Bob/Bob - long.jsonl", message: "The upload didn't reach the server." }]
        })
        const done = yield* api.GetStImport({ importId })
        assert.strictEqual(done.job.status, "complete")
        assert.strictEqual(done.job.filesDone, files.length)
        assert.strictEqual(done.job.bytesDone, bytes)
        assert.strictEqual(done.report!.counts.card?.added, 6)
        assert.deepStrictEqual(
          done.notSent.map((entry) => entry.path),
          ["chats/Bob/Bob - long.jsonl"]
        )
        // Its files are refused once it's over.
        const second = yield* api.StartStImport({ unsupported: [] })
        yield* api.CancelStImport({ importId: second.importId })
        assert.strictEqual((yield* api.GetStImport({ importId: second.importId })).job.status, "cancelled")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    },
    180_000
  )

  it.live("cancelling drains an admitted preset and refuses files arriving during the final write", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const imports = yield* StImports
      const writer = yield* Writer
      const files = stFolder()
      const preset = "OpenAI Settings/Default.json"
      const { importId } = yield* api.StartStImport({ unsupported: [] })
      yield* sendStFile(importId, "settings.json", files.get("settings.json")!)

      const admitted = yield* Deferred.make<void>()
      const releasePreset = yield* Deferred.make<void>()
      const finalWrite = yield* Deferred.make<void>()
      const releaseWrite = yield* Deferred.make<void>()
      const builtin = imports.handlers.get("preset")!
      yield* imports.handlers.register({
        id: "preset",
        run: (call) =>
          Effect.andThen(Deferred.succeed(admitted, undefined), Deferred.await(releasePreset)).pipe(
            Effect.andThen(builtin.run(call))
          )
      })
      const update = writer.StImportJobUpdate
      const pause = vi.spyOn(imports, "withFilesPaused")
      const file = vi.spyOn(imports, "file")
      const write = vi
        .spyOn(writer, "StImportJobUpdate")
        .mockImplementation((input) =>
          input.end?.status === "cancelled"
            ? Deferred.succeed(finalWrite, undefined).pipe(
                Effect.andThen(Deferred.await(releaseWrite)),
                Effect.andThen(update(input))
              )
            : update(input)
        )
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          pause.mockRestore()
          file.mockRestore()
          write.mockRestore()
        })
      )
      const sending = yield* Effect.forkScoped(sendStFile(importId, preset, files.get(preset)!))
      yield* Effect.addFinalizer(() => Deferred.succeed(releasePreset, undefined))
      yield* Deferred.await(admitted)
      const cancelling = yield* Effect.forkScoped(api.CancelStImport({ importId }))
      yield* Effect.addFinalizer(() => Deferred.succeed(releaseWrite, undefined))
      yield* Effect.promise(() => vi.waitFor(() => assert.isTrue(pause.mock.calls.some(([, id]) => id === importId))))
      yield* Deferred.succeed(releasePreset, undefined)
      assert.strictEqual((yield* Fiber.join(sending)).outcome, "added")
      yield* Deferred.await(finalWrite)
      const latePath = "worlds/Hollow.json"
      const late = yield* Effect.forkScoped(sendFile(importId, latePath, files.get(latePath)!))
      yield* Effect.promise(() =>
        vi.waitFor(() => assert.isTrue(file.mock.calls.some(([, , path]) => path === latePath)))
      )
      yield* Deferred.succeed(releaseWrite, undefined)
      yield* Fiber.join(cancelling)
      assert.strictEqual((yield* Fiber.join(late)).status, 404)
      const { job, report } = yield* api.GetStImport({ importId })
      assert.strictEqual(job.status, "cancelled")
      assert.strictEqual(job.filesDone, 2)
      assert.strictEqual(report!.counts.preset?.added, 1)
      assert.isUndefined(report!.counts.lorebook)
      assert.isFalse(report!.issues.some((issue) => issue.code === "st.preset_missing"))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live(
    "a job running when the server stopped is interrupted at the next start, with what it had",
    () => {
      const config = testConfig()
      const id = "01900000-0000-7000-8000-000000000001"
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const api = yield* client()
          const user = yield* api.Whoami()
          const writer = yield* Writer
          yield* writer.StImportJobStart({
            userId: user.id,
            id,
            mode: "path",
            source: "/somewhere/ST",
            root: "/somewhere/ST",
            prefix: "",
            filesTotal: 10,
            bytesTotal: 1000,
            at: Date.now()
          })
          const report = new Report()
          report.issue("settings.json", "warning", "st.preset_missing", "The selected preset wasn't imported.")
          report.issue("broken.json", "error", "st.invalid_json", "Invalid JSON.")
          yield* writer.StImportJobUpdate({
            userId: user.id,
            id,
            at: Date.now(),
            filesTotal: 10,
            filesDone: 4,
            bytesTotal: 1000,
            bytesDone: 400,
            currentFile: "chats/A/A.jsonl",
            countsJson: JSON.stringify({ chat: { added: 4, updated: 0, unchanged: 0, skipped: 0, failed: 0 } }),
            attention: 2,
            reportJson: JSON.stringify(report.build())
          })
          // A recovery checkpoint must not leak its pending warning while still running.
          assert.deepStrictEqual(
            (yield* api.GetStImport({ importId: id })).report!.issues.map((issue) => issue.code),
            ["st.invalid_json"]
          )
        }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
        // The same data folder, a new server.
        yield* Effect.gen(function* () {
          const api = yield* client()
          const [job] = yield* api.ListStImports()
          assert.strictEqual(job!.id, id)
          assert.strictEqual(job!.status, "interrupted")
          assert.strictEqual(job!.filesDone, 4)
          assert.strictEqual(job!.counts.chat?.added, 4)
          assert.isNull(job!.currentFile)
          assert.include(job!.error!, "server stopped")
          assert.deepStrictEqual(
            (yield* api.GetStImport({ importId: id })).report!.issues.map((issue) => issue.code),
            ["st.preset_missing", "st.invalid_json"]
          )
        }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
      })
    },
    180_000
  )
})

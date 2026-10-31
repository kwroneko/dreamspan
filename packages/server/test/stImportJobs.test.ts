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
import type { Notice } from "@rp/shared/noticeApi.ts"
import { classifyStPath } from "@rp/shared/stFolder.ts"
import { Effect, Stream } from "effect"
import { Writer } from "../src/db/Database.ts"
import { databaseFile } from "../src/db/connection.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { card, encode, header, jsonl, message, stFolder } from "./support/stFolder.ts"
import { jobEnded, sendStFile } from "./support/stUpload.ts"
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
            attention: 0
          })
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
        }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
      })
    },
    180_000
  )
})

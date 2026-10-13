// The ST data folder import from a folder's path (ARCHITECTURE.md §13): a synthetic ST folder
// (support/stFolder.ts) written to disk, listed with ScanStFolder and imported file by file
// with ImportStFolderFile, a large chat in several parts, as the import page does it. The
// browser upload's tests (stImport.test.ts) cover what the import does with the files; this
// checks that the same folder read from disk gives the same import. Non-admins are refused
// in isolation.test.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { assert, layer } from "@effect/vitest"
import { classifyStPath, findStRoots, orderStChats, ST_FILE_ORDER } from "@rp/shared/stFolder.ts"
import type { StFileResult, StFolderEntry } from "@rp/shared/stImportApi.ts"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { largeChat, stFolder } from "./support/stFolder.ts"

const config = testConfig()
const folder = new Map(stFolder("ST/data/default-user/"))
// More than one 8 MiB part.
const LARGE = "ST/data/default-user/chats/Bob/Bob - very long.jsonl"
folder.set(LARGE, largeChat(9_000))

/** The files in a new temporary folder, removed when the test's scope closes. */
const onDisk = (files: ReadonlyMap<string, Uint8Array>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const root = mkdtempSync(join(tmpdir(), "rp-st-path-"))
      for (const [path, bytes] of files) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), bytes)
      }
      return root
    }),
    (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true }))
  )

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })("ST folder import by path", (it) => {
  it.effect("imports a folder read from its path, a large chat in parts, as the upload does", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const root = yield* onDisk(folder)
      const scanned = yield* api.ScanStFolder({ path: root })
      const [user] = findStRoots(scanned.files.map((f) => f.path))
      assert.strictEqual(user!.prefix, "ST/data/default-user/")
      const userRoot = `${scanned.root}/ST/data/default-user`
      const mine = scanned.files.flatMap((entry) => {
        const relative = entry.path.slice(user!.prefix.length)
        const file = classifyStPath(relative)
        return file === null ? [] : [{ ...entry, path: relative, file }]
      })
      const { importId } = yield* api.StartStImport({
        unsupported: mine.filter((f) => f.file.kind === "unsupported").map((f) => f.path)
      })
      const isChat = (f: (typeof mine)[number]) => f.file.kind === "chat" || f.file.kind === "group_chat"
      const sorted = mine
        .filter((f) => f.file.kind !== "unsupported")
        .sort(
          (a, b) =>
            ST_FILE_ORDER.indexOf(a.file.kind) - ST_FILE_ORDER.indexOf(b.file.kind) || a.path.localeCompare(b.path)
        )
      const chats = orderStChats(sorted.filter(isChat))
      let next = 0
      const ordered = sorted.map((f) => (isChat(f) ? chats[next++]! : f))

      let parts = 0
      const send = (entry: Pick<StFolderEntry, "path">, orphan = false) =>
        Effect.gen(function* () {
          let start = 0
          for (let part = 0; ; part++) {
            const answer = yield* api.ImportStFolderFile({
              importId,
              root: userRoot,
              path: entry.path,
              start,
              part,
              card: null,
              orphan
            })
            if (entry.path === LARGE.slice(user!.prefix.length)) parts++
            start = answer.next
            if (answer.result.outcome !== "continue") return answer.result
            assert.isFalse(answer.last)
          }
        })
      const answers = new Map<string, StFileResult>()
      const deferred: typeof ordered = []
      for (const entry of ordered) {
        const answer = yield* send(entry)
        if (answer.outcome === "deferred") deferred.push(entry)
        else answers.set(entry.path, answer)
      }
      // The synthetic folder's branches come after their parents, so none should wait.
      assert.lengthOf(deferred, 0)

      const report = yield* api.GetStImportReport({ importId })
      // The same counts as the upload of this folder (stImport.test.ts), plus the large chat.
      assert.deepStrictEqual({ ...report.counts.card }, { added: 6, updated: 0, unchanged: 0, skipped: 0, failed: 0 })
      assert.strictEqual(report.counts.persona?.added, 2)
      assert.strictEqual(report.counts.lorebook?.added, 1)
      assert.strictEqual(report.counts.preset?.added, 1)
      assert.deepStrictEqual({ ...report.counts.chat }, { added: 5, updated: 1, unchanged: 0, skipped: 1, failed: 0 })
      assert.strictEqual(report.counts.group_chat?.added, 1)
      assert.strictEqual(report.greetingOnly, 1)
      assert.strictEqual(answers.get("chats/Twin/Twin - who.jsonl")?.outcome, "needs_link")
      assert.strictEqual(answers.get(LARGE.slice(user!.prefix.length))?.outcome, "added")
      assert.isAbove(parts, 1)

      // Choosing the card for the chat the import couldn't link reads it from disk again.
      const [choice] = report.links
      const linked = yield* api.ImportStFolderFile({
        importId,
        root: userRoot,
        path: choice!.path,
        start: 0,
        part: 0,
        card: choice!.candidates[0]!.entityId,
        orphan: false
      })
      assert.strictEqual(linked.result.outcome, "added")
    })
  )

  it.effect("refuses a relative path, a missing folder and a path outside the import's files", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const refused = <A, E extends { readonly _tag: string }>(call: Effect.Effect<A, E>) =>
        Effect.map(Effect.flip(call), (error) => error._tag)
      assert.strictEqual(yield* refused(api.ScanStFolder({ path: "ST/data" })), "StFolderUnreadable")
      assert.strictEqual(
        yield* refused(api.ScanStFolder({ path: join(tmpdir(), "rp-no-such-folder") })),
        "StFolderUnreadable"
      )
      // The files exist, so only the path check stops them.
      const root = yield* onDisk(
        new Map([
          ["secret.key", new Uint8Array([1])],
          ["user/settings.json", new TextEncoder().encode("{}")]
        ])
      )
      const { importId } = yield* api.StartStImport({ unsupported: [] })
      for (const [base, path] of [
        [root, "secret.key"],
        [join(root, "user"), "../secret.key"],
        [join(root, "user"), "characters/../../secret.key"]
      ] as const) {
        assert.strictEqual(
          yield* refused(
            api.ImportStFolderFile({ importId, root: base, path, start: 0, part: 0, card: null, orphan: false })
          ),
          "StFolderUnreadable"
        )
      }
      // The same call on a file the import reads goes through.
      const settings = yield* api.ImportStFolderFile({
        importId,
        root: join(root, "user"),
        path: "settings.json",
        start: 0,
        part: 0,
        card: null,
        orphan: false
      })
      assert.isTrue(settings.last)
    })
  )
})

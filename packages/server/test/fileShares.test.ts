// Shared folders and the versions list (spec/FILES-AND-ENVIRONMENT.md §1.3, §1.4; files/routes.ts,
// db/fileShares.ts) at the HTTP boundary, with two accounts: nothing of another account's Files is
// reachable without a share, by any route or path spelling; Can view reads and refuses every
// change; Can edit writes into the owner's tree, quota and versions, naming who acted; stopping
// sharing ends access at once; the owner's move carries the share. A version restored is itself
// kept, so restoring that one undoes it. Synthetic files only.
import { assert, describe, it } from "@effect/vitest"
import type { FileVersionEntry, FolderListing, FolderShare, RestoredVersion } from "@dreamspan/shared/files.ts"
import { Effect } from "effect"
import { serverLayer, serverPort, testConfig } from "./support/config.ts"

const as = (handle: string) => {
  const call = (path: string, init: RequestInit = {}) =>
    Effect.gen(function* () {
      const port = yield* serverPort
      return yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          ...init,
          headers: { "remote-user": handle, ...(init.headers as Record<string, string> | undefined) }
        })
      )
    })
  const json = (path: string, body: unknown) =>
    call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const read = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)
  return {
    call,
    json,
    read,
    upload: (path: string, text: string, conflict = "replace") =>
      call(`/files/upload?${new URLSearchParams({ path, conflict })}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: text
      }),
    list: (path: string) => call(`/files/list?${new URLSearchParams({ path })}`),
    listing: (path: string) =>
      Effect.gen(function* () {
        const response = yield* call(`/files/list?${new URLSearchParams({ path })}`)
        assert.strictEqual(response.status, 200, `${handle} lists ${path}`)
        return yield* read<FolderListing>(response)
      }),
    text: (path: string) =>
      Effect.flatMap(call(`/files/raw?${new URLSearchParams({ path })}`), (response) =>
        Effect.promise(() => response.text())
      )
  }
}

const statusOf = <R>(effect: Effect.Effect<Response, never, R>) => Effect.map(effect, (response) => response.status)

describe("shared folders", () => {
  it.live("isolation, Can view, Can edit, stopping, and the owner's move", () =>
    Effect.gen(function* () {
      const wren = as("wren")
      const ash = as("ash")
      const eve = as("eve")
      // Each account exists once it has been seen.
      yield* wren.listing("/files")
      yield* ash.listing("/files")
      yield* eve.listing("/files")
      assert.strictEqual((yield* wren.upload("/files/lighthouse/log.md", "Synthetic log.")).status, 200)
      assert.strictEqual((yield* wren.upload("/files/private/key.txt", "Synthetic secret.")).status, 200)

      // Without a share, nothing of Wren's is reachable by Ash, however the path is spelled.
      for (const path of [
        "/files/Shared/wren/lighthouse/log.md",
        "/files/Shared/wren/../../lighthouse/log.md",
        "/files/../wren/lighthouse/log.md",
        "/files/lighthouse/log.md"
      ])
        assert.notStrictEqual(yield* ash.text(path), "Synthetic log.", path)
      assert.deepStrictEqual((yield* ash.listing("/files")).entries, [])

      // Shares go only to another existing account, only of your own folder.
      assert.strictEqual(
        yield* statusOf(wren.json("/files/share", { path: "/files/lighthouse", handle: "nobody", mode: "view" })),
        404
      )
      assert.strictEqual(
        yield* statusOf(wren.json("/files/share", { path: "/files/lighthouse", handle: "wren", mode: "view" })),
        404
      )
      assert.strictEqual(
        yield* statusOf(wren.json("/files/share", { path: "/files/lighthouse/log.md", handle: "ash", mode: "view" })),
        400
      )
      assert.strictEqual(
        yield* statusOf(wren.json("/files/share", { path: "/files", handle: "ash", mode: "view" })),
        400
      )

      // Can view: Ash reads it under Shared/wren, and every change is refused.
      const viewed = yield* wren.read<FolderShare>(
        yield* wren.json("/files/share", { path: "/files/lighthouse", handle: "ash", mode: "view" })
      )
      assert.deepInclude(viewed, { handle: "ash", mode: "view" })
      assert.deepStrictEqual(
        (yield* wren.read<Array<FolderShare>>(yield* wren.call("/files/shares?path=%2Ffiles%2Flighthouse"))).map(
          (share) => [share.handle, share.mode]
        ),
        [["ash", "view"]]
      )
      assert.deepInclude(
        (yield* wren.listing("/files")).entries.find((entry) => entry.name === "lighthouse")!,
        {
          shared: 1
        }
      )
      // Ash can't read or end Wren's shares.
      assert.strictEqual(yield* statusOf(ash.call("/files/shares?path=%2Ffiles%2Flighthouse")), 404)
      assert.strictEqual(yield* statusOf(ash.json("/files/unshare", { shareId: viewed.id })), 404)

      const top = yield* ash.listing("/files")
      assert.deepStrictEqual(
        top.entries.map((entry) => entry.name),
        ["Shared"]
      )
      assert.deepStrictEqual(
        (yield* ash.listing("/files/Shared")).entries.map((entry) => entry.name),
        ["wren"]
      )
      assert.deepStrictEqual(
        (yield* ash.listing("/files/Shared/wren")).entries.map((entry) => entry.name),
        ["lighthouse"]
      )
      const inside = yield* ash.listing("/files/Shared/wren/lighthouse")
      assert.deepStrictEqual(
        inside.entries.map((entry) => entry.name),
        ["log.md"]
      )
      assert.include(inside, { readOnly: true, bin: false, shared: "view" })
      assert.strictEqual(yield* ash.text("/files/Shared/wren/lighthouse/log.md"), "Synthetic log.")
      // Only the shared folder: its owner's other folders stay out of reach, even beside it.
      assert.strictEqual(yield* statusOf(ash.list("/files/Shared/wren/private")), 404)
      assert.strictEqual(yield* statusOf(ash.list("/files/Shared/wren/lighthouse/../private")), 404)
      assert.notStrictEqual(yield* ash.text("/files/Shared/wren/lighthouse/../private/key.txt"), "Synthetic secret.")
      for (const refused of [
        ash.upload("/files/Shared/wren/lighthouse/log.md", "Changed by Ash."),
        ash.upload("/files/Shared/wren/lighthouse/new.md", "New by Ash."),
        ash.json("/files/folder", { path: "/files/Shared/wren/lighthouse/sub" }),
        ash.json("/files/delete", { path: "/files/Shared/wren/lighthouse/log.md" }),
        ash.json("/files/move", {
          from: "/files/Shared/wren/lighthouse/log.md",
          to: "/files/Shared/wren/lighthouse/moved.md"
        })
      ])
        assert.strictEqual(yield* statusOf(refused), 403)
      assert.strictEqual(yield* wren.text("/files/lighthouse/log.md"), "Synthetic log.")
      // Eve, shared nothing, still sees nothing.
      assert.deepStrictEqual((yield* eve.listing("/files")).entries, [])
      assert.notStrictEqual(yield* eve.text("/files/Shared/wren/lighthouse/log.md"), "Synthetic log.")

      // Can edit: Ash's save lands in Wren's tree, the version records Ash, Wren's quota pays.
      const edit = yield* wren.read<FolderShare>(
        yield* wren.json("/files/share", { path: "/files/lighthouse", handle: "ash", mode: "edit" })
      )
      assert.strictEqual(edit.id, viewed.id)
      assert.strictEqual((yield* ash.upload("/files/Shared/wren/lighthouse/log.md", "Changed by Ash.")).status, 200)
      assert.strictEqual(yield* wren.text("/files/lighthouse/log.md"), "Changed by Ash.")
      const versions = yield* wren.read<Array<FileVersionEntry>>(
        yield* wren.call("/files/versions?path=%2Ffiles%2Flighthouse%2Flog.md")
      )
      assert.strictEqual(versions.length, 1)
      assert.deepInclude(versions[0]!, { origin: "upload", restorable: true })
      assert.strictEqual(versions[0]!.actor?.handle, "ash")
      // Ash sees the same record, from the path Ash names it by, and Ash's own act isn't named.
      const theirs = yield* ash.read<Array<FileVersionEntry>>(
        yield* ash.call("/files/versions?path=%2Ffiles%2FShared%2Fwren%2Flighthouse%2Flog.md")
      )
      assert.deepStrictEqual(
        theirs.map((version) => [version.id, version.actor]),
        [[versions[0]!.id, null]]
      )
      // The shared folder itself is its owner's to move, delete or share; moves stay inside it.
      assert.strictEqual(yield* statusOf(ash.json("/files/delete", { path: "/files/Shared/wren/lighthouse" })), 400)
      assert.strictEqual(
        yield* statusOf(ash.json("/files/move", { from: "/files/Shared/wren/lighthouse/log.md", to: "/files/log.md" })),
        400
      )
      assert.strictEqual(
        yield* statusOf(
          ash.json("/files/share", { path: "/files/Shared/wren/lighthouse", handle: "eve", mode: "edit" })
        ),
        400
      )
      // A delete there goes to Wren's bin, with no Undo for Ash.
      assert.strictEqual((yield* ash.upload("/files/Shared/wren/lighthouse/scratch.md", "Scratch.")).status, 200)
      const deleted = yield* ash.read<{ binItemId: string | null }>(
        yield* ash.json("/files/delete", { path: "/files/Shared/wren/lighthouse/scratch.md" })
      )
      assert.isNull(deleted.binItemId)
      assert.deepStrictEqual(
        (yield* wren.listing("/files/lighthouse")).entries.map((entry) => entry.name),
        ["log.md"]
      )

      // The owner's rename carries the share; Ash finds it under the new name.
      assert.strictEqual(
        (yield* wren.json("/files/move", { from: "/files/lighthouse", to: "/files/beacon" })).status,
        200
      )
      assert.deepStrictEqual(
        (yield* ash.listing("/files/Shared/wren")).entries.map((entry) => entry.name),
        ["beacon"]
      )
      assert.strictEqual(yield* ash.text("/files/Shared/wren/beacon/log.md"), "Changed by Ash.")

      // Stopping: the next request no longer reaches it, and Shared goes from Ash's top.
      assert.strictEqual((yield* wren.json("/files/unshare", { shareId: edit.id })).status, 200)
      assert.strictEqual(yield* statusOf(ash.list("/files/Shared/wren/beacon")), 404)
      assert.notStrictEqual(yield* ash.text("/files/Shared/wren/beacon/log.md"), "Changed by Ash.")
      assert.deepStrictEqual((yield* ash.listing("/files")).entries, [])
      assert.strictEqual(yield* statusOf(wren.json("/files/unshare", { shareId: edit.id })), 404)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ authMode: "proxy" }))))
  )

  it.live("versions: listed with what replaced them, restored, and the restore undone", () =>
    Effect.gen(function* () {
      const wren = as("wren")
      const ash = as("ash")
      yield* ash.listing("/files")
      yield* wren.upload("/files/notes/plan.md", "First.")
      yield* wren.upload("/files/notes/plan.md", "Second.")
      yield* wren.upload("/files/notes/plan.md", "Third.")
      const listed = yield* wren.read<Array<FileVersionEntry>>(
        yield* wren.call("/files/versions?path=%2Ffiles%2Fnotes%2Fplan.md")
      )
      assert.strictEqual(listed.length, 2)
      // Newest first: "Second." then "First.", each replaced by an upload.
      assert.deepStrictEqual(
        listed.map((version) => [version.origin, version.byteSize, version.actor]),
        [
          ["upload", 7, null],
          ["upload", 6, null]
        ]
      )
      const first = listed[1]!
      // Another account can't list or restore them.
      assert.strictEqual(
        (yield* ash.read<Array<unknown>>(yield* ash.call("/files/versions?path=%2Ffiles%2Fnotes%2Fplan.md"))).length,
        0
      )
      assert.strictEqual(
        yield* statusOf(ash.json("/files/versions/restore", { path: "/files/notes/plan.md", versionId: first.id })),
        404
      )
      // A version restores only to its own file.
      yield* wren.upload("/files/notes/other.md", "Other.")
      assert.strictEqual(
        yield* statusOf(wren.json("/files/versions/restore", { path: "/files/notes/other.md", versionId: first.id })),
        404
      )

      const restored = yield* wren.read<RestoredVersion>(
        yield* wren.json("/files/versions/restore", { path: "/files/notes/plan.md", versionId: first.id })
      )
      assert.strictEqual(restored.path, "/files/notes/plan.md")
      assert.strictEqual(yield* wren.text("/files/notes/plan.md"), "First.")
      const after = yield* wren.read<Array<FileVersionEntry>>(
        yield* wren.call("/files/versions?path=%2Ffiles%2Fnotes%2Fplan.md")
      )
      assert.strictEqual(after[0]!.id, restored.keptVersionId)
      assert.strictEqual(after[0]!.origin, "restore")
      // Restoring what the restore kept undoes it.
      yield* wren.json("/files/versions/restore", { path: "/files/notes/plan.md", versionId: restored.keptVersionId })
      assert.strictEqual(yield* wren.text("/files/notes/plan.md"), "Third.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ authMode: "proxy" }))))
  )
})

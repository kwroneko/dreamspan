// Shared folders and the versions list (spec/FILES-AND-ENVIRONMENT.md §1.3, §1.4; files/routes.ts,
// db/fileShares.ts) at the HTTP boundary, with two accounts: nothing of another account's Files is
// reachable without a share, by any route or path spelling; Can view reads and refuses every
// change; Can edit writes into the owner's tree, quota and versions, naming who acted; stopping
// sharing ends access at once; the owner's move carries the share. A version restored is itself
// kept, so restoring that one undoes it. Synthetic files only.
import { assert, describe, it } from "@effect/vitest"
import type { FileVersionEntry, FolderListing, FolderShare, RestoredVersion } from "@dreamspan/shared/files.ts"
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

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

/** The account folder on disk that holds `marker` at its top (a command's view of it). */
const treeHolding = (dataDir: string, marker: string) => {
  const filesDir = join(dataDir, "files")
  const account = readdirSync(filesDir).find((name) => existsSync(join(filesDir, name, marker)))
  assert.isDefined(account, marker)
  return join(filesDir, account!)
}

/** Wren offers the folder to Ash, and Ash accepts. */
const shareAccepted = (
  owner: ReturnType<typeof as>,
  grantee: ReturnType<typeof as>,
  path: string,
  handle: string,
  mode: "view" | "edit"
) =>
  Effect.gen(function* () {
    assert.strictEqual((yield* owner.json("/files/share", { path, handle, mode })).status, 200)
    const folder = path.slice(path.lastIndexOf("/") + 1)
    const invitation = (yield* grantee.listing("/files")).invitations?.find((offer) => offer.folder === folder)
    assert.isDefined(invitation, `${handle} is offered ${path}`)
    assert.strictEqual(
      (yield* grantee.json("/files/invitation", { invitationId: invitation!.id, accept: true })).status,
      200
    )
  })

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

      // Shares go only to another account, only of your own folder; a name that's no account's
      // gets the same answer as one that is (review files4b finding 6), and reaches nobody.
      const unknown = yield* wren.json("/files/share", { path: "/files/lighthouse", handle: "nobody", mode: "view" })
      assert.strictEqual(unknown.status, 200)
      assert.deepInclude(yield* wren.read<FolderShare>(unknown), {
        handle: "nobody",
        displayName: "nobody",
        status: "invited"
      })
      assert.strictEqual(
        yield* statusOf(wren.json("/files/share", { path: "/files/lighthouse", handle: "wren", mode: "view" })),
        400
      )
      assert.strictEqual(
        yield* statusOf(wren.json("/files/share", { path: "/files/lighthouse/log.md", handle: "ash", mode: "view" })),
        400
      )
      assert.strictEqual(
        yield* statusOf(wren.json("/files/share", { path: "/files", handle: "ash", mode: "view" })),
        400
      )

      // Can view: an invitation first (review files4b finding 5): nothing is mounted until Ash accepts.
      const invited = yield* wren.read<FolderShare>(
        yield* wren.json("/files/share", { path: "/files/lighthouse", handle: "ash", mode: "view" })
      )
      // Told apart from the unknown name by nothing but the name typed.
      assert.deepStrictEqual(invited, {
        id: invited.id,
        handle: "ash",
        displayName: "ash",
        mode: "view",
        status: "invited"
      })
      assert.deepStrictEqual(
        (yield* wren.read<Array<FolderShare>>(yield* wren.call("/files/shares?path=%2Ffiles%2Flighthouse"))).map(
          (share) => [share.handle, share.status]
        ),
        [
          ["nobody", "invited"],
          ["ash", "invited"]
        ]
      )
      const offered = yield* ash.listing("/files")
      assert.deepStrictEqual(
        offered.invitations?.map((invitation) => [invitation.ownerHandle, invitation.folder, invitation.mode]),
        [["wren", "lighthouse", "view"]]
      )
      assert.strictEqual(yield* statusOf(ash.list("/files/Shared/wren/lighthouse")), 404)
      assert.notStrictEqual(yield* ash.text("/files/Shared/wren/lighthouse/log.md"), "Synthetic log.")
      // Only Ash can answer it.
      assert.strictEqual(
        yield* statusOf(eve.json("/files/invitation", { invitationId: offered.invitations![0]!.id, accept: true })),
        404
      )
      assert.strictEqual(
        (yield* ash.json("/files/invitation", { invitationId: offered.invitations![0]!.id, accept: true })).status,
        200
      )
      const viewed = (yield* wren.read<Array<FolderShare>>(
        yield* wren.call("/files/shares?path=%2Ffiles%2Flighthouse")
      )).find((share) => share.handle === "ash")!
      assert.deepInclude(viewed, { handle: "ash", mode: "view", status: "active" })
      assert.deepInclude(
        (yield* wren.listing("/files")).entries.find((entry) => entry.name === "lighthouse")!,
        {
          shared: 2
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

  it.live("through a share, only versions kept since it started, of a file there now", () =>
    Effect.gen(function* () {
      // review files4b finding 1: the path's history from before the share was readable and restorable.
      const wren = as("wren")
      const ash = as("ash")
      yield* ash.listing("/files")
      yield* wren.upload("/files/A/notes.txt", "Private, before sharing.")
      yield* wren.upload("/files/A/notes.txt", "Now.")
      yield* wren.upload("/files/A/gone.txt", "Also private.")
      yield* wren.json("/files/delete", { path: "/files/A/gone.txt" })
      const before = yield* wren.read<Array<FileVersionEntry>>(
        yield* wren.call("/files/versions?path=%2Ffiles%2FA%2Fnotes.txt")
      )
      assert.strictEqual(before.length, 1)
      yield* shareAccepted(wren, ash, "/files/A", "ash", "edit")

      assert.deepStrictEqual(
        yield* ash.read<Array<FileVersionEntry>>(
          yield* ash.call("/files/versions?path=%2Ffiles%2FShared%2Fwren%2FA%2Fnotes.txt")
        ),
        []
      )
      // A file not there now lists nothing at all.
      assert.strictEqual(yield* statusOf(ash.call("/files/versions?path=%2Ffiles%2FShared%2Fwren%2FA%2Fgone.txt")), 404)
      // And a version from before can't be restored into the share by its id.
      assert.strictEqual(
        yield* statusOf(
          ash.json("/files/versions/restore", { path: "/files/Shared/wren/A/notes.txt", versionId: before[0]!.id })
        ),
        404
      )
      assert.strictEqual(yield* wren.text("/files/A/notes.txt"), "Now.")
      // What's kept after it started is theirs to see and restore.
      yield* ash.upload("/files/Shared/wren/A/notes.txt", "Ash's edit.")
      const since = yield* ash.read<Array<FileVersionEntry>>(
        yield* ash.call("/files/versions?path=%2Ffiles%2FShared%2Fwren%2FA%2Fnotes.txt")
      )
      assert.strictEqual(since.length, 1)
      assert.strictEqual(
        (yield* ash.json("/files/versions/restore", {
          path: "/files/Shared/wren/A/notes.txt",
          versionId: since[0]!.id
        })).status,
        200
      )
      assert.strictEqual(yield* wren.text("/files/A/notes.txt"), "Now.")
      // The owner still sees the whole record.
      assert.strictEqual(
        (yield* wren.read<Array<FileVersionEntry>>(yield* wren.call("/files/versions?path=%2Ffiles%2FA%2Fnotes.txt")))
          .length,
        3
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ authMode: "proxy" }))))
  )

  it.live("a share is bound to its folder: moved away, replaced or deleted, it stops until shared again", () => {
    // review files4b finding 2: a share followed the path, so whatever stood there next was shared.
    const config = testConfig({ authMode: "proxy" })
    return Effect.gen(function* () {
      const wren = as("wren")
      const ash = as("ash")
      yield* ash.listing("/files")
      yield* wren.upload("/files/A/shared.txt", "Shared on purpose.")
      yield* shareAccepted(wren, ash, "/files/A", "ash", "edit")
      assert.strictEqual(yield* ash.text("/files/Shared/wren/A/shared.txt"), "Shared on purpose.")

      // A command moves it away and makes a private folder of the same name.
      const tree = treeHolding(config.dataDir, "A")
      renameSync(join(tree, "A"), join(tree, "B"))
      mkdirSync(join(tree, "A"))
      writeFileSync(join(tree, "A", "secret.txt"), "Never shared.")
      const listed = yield* ash.listing("/files/Shared/wren")
      assert.deepStrictEqual(
        listed.entries.map((entry) => [entry.name, entry.unavailable ?? false]),
        [["A", true]]
      )
      for (const path of ["/files/Shared/wren/A", "/files/Shared/wren/A/secret.txt"])
        assert.strictEqual(yield* statusOf(ash.list(path)), 404, path)
      assert.notStrictEqual(yield* ash.text("/files/Shared/wren/A/secret.txt"), "Never shared.")
      assert.strictEqual(yield* statusOf(ash.upload("/files/Shared/wren/A/new.txt", "x")), 404)
      // The owner is told, and the badge isn't on the private folder.
      const top = yield* wren.listing("/files")
      assert.deepStrictEqual(
        top.unavailableShares?.map((share) => [share.path, share.handle, share.reason, share.folderThere]),
        [["/files/A", "ash", "moved", true]]
      )
      assert.isUndefined(top.entries.find((entry) => entry.name === "A")!.shared)
      // Sharing it again shares the folder there now, on the owner's word.
      const again = yield* wren.read<FolderShare>(
        yield* wren.json("/files/share/again", { shareId: top.unavailableShares![0]!.id })
      )
      assert.strictEqual(again.status, "active")
      assert.strictEqual(yield* ash.text("/files/Shared/wren/A/secret.txt"), "Never shared.")

      // Deleted in the app: it stops, and restoring it from the bin doesn't share it again.
      const deleted = yield* wren.read<{ binItemId: string }>(yield* wren.json("/files/delete", { path: "/files/A" }))
      assert.strictEqual(yield* statusOf(ash.list("/files/Shared/wren/A")), 404)
      assert.strictEqual((yield* wren.json("/files/restore", { binItemId: deleted.binItemId })).status, 200)
      assert.strictEqual(yield* statusOf(ash.list("/files/Shared/wren/A")), 404)
      assert.deepStrictEqual(
        (yield* wren.listing("/files")).unavailableShares?.map((share) => [share.path, share.reason]),
        [["/files/A", "bin"]]
      )
      yield* wren.json("/files/share/again", { shareId: again.id })
      assert.strictEqual((yield* ash.list("/files/Shared/wren/A")).status, 200)

      // A move in the app carries it, and a stale share where it lands doesn't block that.
      assert.strictEqual((yield* wren.json("/files/move", { from: "/files/A", to: "/files/C" })).status, 200)
      assert.strictEqual(yield* ash.text("/files/Shared/wren/C/secret.txt"), "Never shared.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a share never hides the other account's own folder of that name", () => {
    // review files4b finding 5: an unasked share took over the grantee's own Shared/<owner>/<folder>.
    const config = testConfig({ authMode: "proxy" })
    return Effect.gen(function* () {
      const wren = as("wren")
      const ash = as("ash")
      yield* wren.upload("/files/notes/theirs.txt", "Wren's.")
      yield* ash.upload("/files/Shared/wren/notes/mine.txt", "Ash's own.")
      yield* shareAccepted(wren, ash, "/files/notes", "ash", "view")
      assert.deepStrictEqual((yield* ash.listing("/files/Shared/wren")).entries.map((entry) => entry.name).sort(), [
        "notes",
        "notes (2)"
      ])
      // Ash's own folder is Ash's, to read and to change; the share is beside it.
      assert.strictEqual(yield* ash.text("/files/Shared/wren/notes/mine.txt"), "Ash's own.")
      assert.strictEqual((yield* ash.upload("/files/Shared/wren/notes/more.txt", "More.")).status, 200)
      assert.strictEqual(yield* ash.text("/files/Shared/wren/notes (2)/theirs.txt"), "Wren's.")
      assert.deepStrictEqual(
        (yield* wren.listing("/files/notes")).entries.map((entry) => entry.name),
        ["theirs.txt"]
      )
      // A folder Ash makes there later moves the share aside rather than hiding it.
      const tree = treeHolding(config.dataDir, "Shared")
      mkdirSync(join(tree, "Shared", "wren", "notes (2)"))
      assert.deepStrictEqual((yield* ash.listing("/files/Shared/wren")).entries.map((entry) => entry.name).sort(), [
        "notes",
        "notes (2)",
        "notes (3)"
      ])
      assert.strictEqual(yield* ash.text("/files/Shared/wren/notes (3)/theirs.txt"), "Wren's.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("invitations: declined, taken back, rate-limited, and pinned to the account they were sent to", () =>
    Effect.gen(function* () {
      const wren = as("wren")
      const ash = as("ash")
      yield* ash.listing("/files")
      yield* wren.upload("/files/A/a.txt", "A.")
      yield* wren.upload("/files/B/b.txt", "B.")
      // Declined: it goes, and nothing is mounted.
      yield* wren.json("/files/share", { path: "/files/A", handle: "ash", mode: "edit" })
      const offer = (yield* ash.listing("/files")).invitations![0]!
      yield* ash.json("/files/invitation", { invitationId: offer.id, accept: false })
      assert.isUndefined((yield* ash.listing("/files")).invitations)
      assert.strictEqual(yield* statusOf(ash.list("/files/Shared/wren/A")), 404)
      // The owner sees what they'd see for a name no account has: still Invited, until withdrawn.
      const afterDecline = yield* wren.read<Array<FolderShare>>(yield* wren.call("/files/shares?path=%2Ffiles%2FA"))
      assert.deepStrictEqual(
        afterDecline.map(({ handle, status }) => [handle, status]),
        [["ash", "invited"]]
      )
      // It can't be answered again, and the owner can still withdraw it.
      assert.strictEqual(yield* statusOf(ash.json("/files/invitation", { invitationId: offer.id, accept: true })), 404)
      assert.strictEqual(yield* statusOf(wren.json("/files/unshare", { shareId: afterDecline[0]!.id })), 200)
      assert.deepStrictEqual(
        yield* wren.read<Array<FolderShare>>(yield* wren.call("/files/shares?path=%2Ffiles%2FA")),
        []
      )
      // Taken back before it's answered: it can't be accepted.
      const sent = yield* wren.read<FolderShare>(
        yield* wren.json("/files/share", { path: "/files/B", handle: "ash", mode: "view" })
      )
      const pending = (yield* ash.listing("/files")).invitations![0]!
      yield* wren.json("/files/unshare", { shareId: sent.id })
      assert.strictEqual(
        yield* statusOf(ash.json("/files/invitation", { invitationId: pending.id, accept: true })),
        404
      )
      // An invitation to a name no account has never reaches an account made later under it.
      yield* wren.json("/files/share", { path: "/files/A", handle: "late", mode: "edit" })
      const late = as("late")
      assert.isUndefined((yield* late.listing("/files")).invitations)
      assert.strictEqual(yield* statusOf(late.list("/files/Shared/wren/A")), 404)
      // Many invitations at once are refused for a while.
      let refused = 0
      for (let i = 0; i < 25; i++)
        if (
          (yield* statusOf(wren.json("/files/share", { path: "/files/B", handle: `probe${i}`, mode: "view" }))) === 429
        )
          refused++
      assert.isAbove(refused, 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ authMode: "proxy" }))))
  )

  it.live("an upload streaming when its share stops is refused as it lands; a delete in a share names who did it", () =>
    Effect.gen(function* () {
      const wren = as("wren")
      const ash = as("ash")
      yield* ash.listing("/files")
      yield* wren.upload("/files/A/a.txt", "A.")
      yield* shareAccepted(wren, ash, "/files/A", "ash", "edit")
      const port = yield* serverPort
      let open!: () => void
      const gate = new Promise<void>((resolve) => (open = resolve))
      const streaming = fetch(
        `http://127.0.0.1:${port}/files/upload?${new URLSearchParams({ path: "/files/Shared/wren/A/late.txt", conflict: "ask" })}`,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream", "remote-user": "ash" },
          duplex: "half",
          body: new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("Late"))
              await gate
              controller.enqueue(new TextEncoder().encode(" text."))
              controller.close()
            }
          })
        } as RequestInit
      )
      yield* Effect.sleep("300 millis")
      const [share] = yield* wren.read<Array<FolderShare>>(yield* wren.call("/files/shares?path=%2Ffiles%2FA"))
      yield* wren.json("/files/unshare", { shareId: share!.id })
      open()
      assert.strictEqual((yield* Effect.promise(() => streaming)).status, 404)
      assert.deepStrictEqual(
        (yield* wren.listing("/files/A")).entries.map((entry) => entry.name),
        ["a.txt"]
      )

      // Ash's delete in Wren's folder goes to Wren's bin, saying it was Ash.
      yield* shareAccepted(wren, ash, "/files/A", "ash", "edit")
      yield* ash.json("/files/delete", { path: "/files/Shared/wren/A/a.txt" })
      const api = yield* client({ "remote-user": "wren" })
      const [item] = yield* api.ListBin({ limit: 10, before: null })
      assert.strictEqual(item!.origin.path, "/files/A/a.txt")
      assert.strictEqual((item!.origin.by as { handle: string } | undefined)?.handle, "ash")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ authMode: "proxy" }))))
  )

  it.live("a share is bound to its folder's birth time too, so a reused inode number never inherits it", () => {
    const config = testConfig({ authMode: "proxy" })
    return Effect.gen(function* () {
      const wren = as("wren")
      const ash = as("ash")
      yield* ash.listing("/files")
      yield* wren.upload("/files/A/a.txt", "A.")
      yield* shareAccepted(wren, ash, "/files/A", "ash", "edit")
      const [row] = (yield* fixtureSql(config.dataDir, [{ sql: "SELECT birth_ms FROM file_shares" }]))[0]!
      // Where the filesystem gives a birth time, it's recorded (Node reports 0 where it doesn't).
      const recorded = row!.birth_ms as number | null
      if (recorded === null) return
      assert.isAbove(recorded, 0)
      assert.strictEqual(yield* ash.text("/files/Shared/wren/A/a.txt"), "A.")
      // The folder at the path is born at another time, as a recreated one with the same inode
      // number would be: not the shared folder.
      yield* fixtureSql(config.dataDir, [{ sql: "UPDATE file_shares SET birth_ms = birth_ms - 5000" }])
      assert.strictEqual(yield* statusOf(ash.list("/files/Shared/wren/A")), 404)
      assert.strictEqual(yield* statusOf(ash.upload("/files/Shared/wren/A/new.txt", "x")), 404)
      // Without a recorded birth time (a filesystem with none), the inode and device decide.
      yield* fixtureSql(config.dataDir, [{ sql: "UPDATE file_shares SET birth_ms = NULL" }])
      assert.strictEqual(yield* ash.text("/files/Shared/wren/A/a.txt"), "A.")
      const downgrade = yield* wren.json("/files/share", { path: "/files/A", handle: "ash", mode: "view" })
      assert.strictEqual(downgrade.status, 200)
      assert.deepInclude(yield* wren.read<FolderShare>(downgrade), { status: "active", mode: "view" })
      assert.strictEqual(yield* statusOf(ash.upload("/files/Shared/wren/A/new.txt", "x")), 403)
      assert.isEmpty((yield* ash.listing("/files")).invitations ?? [])
      // Sharing it again binds the folder as it is now, birth time included.
      yield* fixtureSql(config.dataDir, [{ sql: "UPDATE file_shares SET birth_ms = 1" }])
      assert.strictEqual(yield* statusOf(ash.list("/files/Shared/wren/A")), 404)
      const top = yield* wren.listing("/files")
      yield* wren.json("/files/share/again", { shareId: top.unavailableShares![0]!.id })
      assert.strictEqual(yield* ash.text("/files/Shared/wren/A/a.txt"), "A.")
      const [after] = (yield* fixtureSql(config.dataDir, [{ sql: "SELECT birth_ms FROM file_shares" }]))[0]!
      assert.strictEqual(after!.birth_ms, recorded)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

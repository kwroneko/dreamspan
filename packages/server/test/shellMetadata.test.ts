import { Worker } from "node:worker_threads"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { NewVersion } from "@rp/shared/chat.ts"
import * as Database from "../src/db/Database.ts"
import { databaseFile } from "../src/db/connection.ts"
import { testWorkers } from "./support/bundles.ts"
import { tempDir } from "./support/tempDir.ts"

it.live("unsplit named-chat navigation reads endpoints, not the library tree, and retains exact ordering", () => {
  const dataDir = tempDir("shell-metadata")
  return Effect.gen(function* () {
    const writer = yield* Database.Writer
    const { id: userId } = yield* writer.EnsureUser({ handle: "owner", displayName: "Owner" })
    const { id: otherUserId } = yield* writer.EnsureUser({ handle: "other", displayName: "Other" })
    const chat = yield* writer.CreateChat({
      userId,
      title: "Named synthetic chat",
      kind: "rp",
      status: "active",
      participants: [],
      greeting: null
    })
    const unrelated = yield* writer.CreateChat({
      userId,
      title: "Unrelated",
      kind: "rp",
      status: "active",
      participants: [],
      greeting: null
    })
    const append = (chatId: typeof chat.id, parentSlotId: typeof chat.activeLeafSlotId) =>
      writer.AppendMessage({
        userId,
        chatId,
        parentSlotId,
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          content: "Synthetic text",
          writer: "human",
          speakerEntityId: null,
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })
    const root = yield* append(chat.id, null)
    const tip = yield* append(chat.id, root.slotId)
    const branch = yield* writer.CreateFork({
      userId,
      chatId: chat.id,
      fromForkId: chat.currentForkId,
      atSlotId: root.slotId
    })
    // Endpoint choices differ by fork, including a replacement and a selection
    // made after the child froze its parent's state. Navigation must use the same
    // fork-state probes as the full outline, without walking either path.
    const alternate = (slotId: typeof root.slotId, forkId: typeof branch.fork.id) =>
      writer.AddVersion({
        userId,
        slotId,
        forkId,
        version: new NewVersion({
          content: "Synthetic selected alternative",
          writer: "human",
          speakerEntityId: null,
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        }),
        select: true,
        commitDraft: null
      })
    yield* alternate(root.slotId, chat.currentForkId!)
    yield* alternate(tip.slotId, chat.currentForkId!)
    const selected = yield* alternate(root.slotId, branch.fork.id)
    yield* writer.AmendVersion({
      userId,
      versionId: selected.id,
      forkId: branch.fork.id,
      content: "Synthetic edited alternative",
      expectedRowVersion: selected.rowVersion
    })
    yield* append(unrelated.id, null)
    const probe = yield* Effect.promise(
      () =>
        new Promise<{
          actual: unknown
          expected: unknown
          ownThreads: unknown[]
          foreign: string
          foreignThread: string
          queries: string[]
        }>((resolve, reject) => {
          const worker = new Worker(new URL("./support/navigationProbeWorker.ts", import.meta.url), {
            workerData: { file: databaseFile(dataDir), userId, otherUserId, chatId: chat.id, forkId: branch.fork.id }
          })
          worker.once("message", resolve)
          worker.once("error", reject)
        })
    )
    assert.strictEqual(JSON.stringify(probe.actual), JSON.stringify(probe.expected))
    assert.deepStrictEqual(probe.ownThreads, [])
    assert.strictEqual(probe.foreign, "NotFound")
    assert.strictEqual(probe.foreignThread, "NotFound")
    assert.isFalse(
      probe.queries.some(
        (text) =>
          text.includes("version_participants") ||
          text.includes("FROM segments g") ||
          text.includes("SELECT NULL AS fork_id") ||
          text.includes("CROSS JOIN slots s ON s.chat_id = j.value")
      ),
      "neither navigation read may walk a message path or materialize the shell"
    )
    const shared = yield* Effect.promise(
      () =>
        new Promise<{
          executions: number
          materializations: number
          actual: unknown
          expected: unknown
        }>((resolve, reject) => {
          const worker = new Worker(new URL("./support/materializationProbeWorker.ts", import.meta.url), {
            workerData: { file: databaseFile(dataDir), userId }
          })
          worker.once("message", resolve)
          worker.once("error", reject)
        })
    )
    assert.strictEqual(shared.materializations, 1)
    assert.strictEqual(
      shared.executions,
      1,
      "one actual full-tree SQL execution for the navigation's simultaneous shell views"
    )
    assert.strictEqual(
      JSON.stringify(shared.actual),
      JSON.stringify(shared.expected),
      "all projected response bytes agree with independent worker reads"
    )
    const folding = yield* Effect.promise(
      () =>
        new Promise<{
          positionEntries: number
          emptyEvidenceParses: number
          fresh: number
          forks: number
        }>((resolve, reject) => {
          const worker = new Worker(new URL("./support/foldingProbeWorker.ts", import.meta.url), {
            workerData: { file: databaseFile(dataDir), userId, chatId: chat.id }
          })
          worker.once("message", resolve)
          worker.once("error", reject)
        })
    )
    assert.isAbove(folding.fresh, 0, "exercise a real cold summary fold")
    assert.strictEqual(folding.forks, 3)
    assert.strictEqual(
      folding.positionEntries,
      0,
      "unthreaded branches without positional events need no whole-path position map"
    )
    assert.strictEqual(folding.emptyEvidenceParses, 0, "empty shared evidence is never reparsed per branch")
    const reader = yield* Database.Reader
    const epoch = yield* reader.ShellEpoch({ userId })
    const snapshot = yield* reader.ShellMaterialize({ userId })
    yield* writer.StoreForkSummaries({ userId, chats: snapshot.fresh })
    yield* writer.EnsureUser({ handle: "owner", displayName: "Owner" })
    yield* writer.CreateChat({
      userId: otherUserId,
      title: "Other account",
      kind: "rp",
      status: "active",
      participants: [],
      greeting: null
    })
    assert.strictEqual(
      yield* reader.ShellEpoch({ userId }),
      epoch,
      "persistence, authentication and another account do not invalidate display metadata"
    )
    assert.strictEqual(yield* reader.ShellMaterialize({ userId }), snapshot)
    yield* writer.SetHomePinsCollapsed({ userId, collapsed: true })
    assert.notStrictEqual(yield* reader.ShellEpoch({ userId }), epoch)
    assert.isTrue((yield* reader.ShellMaterialize({ userId })).pinsCollapsed)
  }).pipe(Effect.provide(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers })), Effect.scoped)
})

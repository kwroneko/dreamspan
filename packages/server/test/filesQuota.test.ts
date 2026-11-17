// The Files quota and version retention (spec/FILES-AND-ENVIRONMENT.md §1.2, §1.3): a run over
// a small quota is refused new writes and commands with how much it uses, the usage RPC says
// so, an admin's quota lifts it, and retention removes old versions and the media only they
// named. Synthetic data only.
import { link, mkdir, symlink, truncate, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { measureTree, parseByteSize } from "../src/files/quota.ts"
import { WorkshopFiles } from "../src/files/WorkshopFiles.ts"
import { linuxBwrap } from "../src/sandbox/linuxBwrap.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider, type Recorded } from "./support/mockProvider.ts"
import { tempDir } from "./support/tempDir.ts"
import { unquoteToolData } from "./support/toolData.ts"

const commands = (await linuxBwrap.available()).ok

const call = (name: string, args: unknown, id: string) => [
  {
    id: "tool",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "tool",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]

describe("measuring", () => {
  it("reads sizes with binary units", () => {
    assert.strictEqual(parseByteSize("10G"), 10 * 2 ** 30)
    assert.strictEqual(parseByteSize("512M"), 512 * 2 ** 20)
    assert.strictEqual(parseByteSize("1.5GiB"), 1.5 * 2 ** 30)
    assert.strictEqual(parseByteSize("2048"), 2048)
    assert.isNull(parseByteSize("ten gigs"))
    assert.isNull(parseByteSize("-1G"))
  })

  it.live("counts sizes, each inode once, and never follows links", () =>
    Effect.promise(async () => {
      const root = tempDir("measure")
      const outside = tempDir("measure-outside")
      await writeFile(join(outside, "big"), Buffer.alloc(4 * 2 ** 20, 1))
      await mkdir(join(root, "sub"))
      await writeFile(join(root, "sub", "a"), Buffer.alloc(2 ** 20, 1))
      // A hard link to the same file, a link out, and a sparse file of 1 GiB, which counts in
      // full (a compressing filesystem would otherwise make anything look small).
      await link(join(root, "sub", "a"), join(root, "a-again"))
      await symlink(outside, join(root, "out"))
      await writeFile(join(root, "sparse"), "")
      await truncate(join(root, "sparse"), 2 ** 30)
      const measured = await measureTree(root)
      assert.isFalse(measured.partial)
      assert.isAtLeast(measured.bytes, 2 ** 30 + 2 ** 20)
      assert.isBelow(measured.bytes, 2 ** 30 + 2 * 2 ** 20)
      const missing = await measureTree(join(root, "nothing"))
      assert.strictEqual(missing.bytes, 0)
      const cut = await measureTree(root, 2)
      assert.isTrue(cut.partial)
    })
  )
})

it.live.skipIf(!commands)(
  "refuses writes and commands over the quota, says so, and an admin's quota lifts it",
  () => {
    const config = testConfig({ filesQuota: "1M" })
    return Effect.gen(function* () {
      const requests: Array<{ messages: Array<{ role: string; content?: string }> }> = []
      const steps: Array<[string, unknown]> = [
        ["bash", { command: "echo small > small.txt && echo ran-1" }],
        ["bash", { command: "head -c 3000000 /dev/urandom > big.bin && echo ran-2" }],
        ["bash", { command: "echo ran-3" }],
        ["write_file", { path: "notes.md", content: "more" }],
        ["read_file", { path: "small.txt" }]
      ]
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((r: Recorded, res) => {
            const b = r.body as unknown as (typeof requests)[number]
            if (!JSON.stringify(b.messages).includes("QUOTA TASK")) return sse(res, completionChunks(["Ready."], {}))
            requests.push(b)
            const from = b.messages.findLastIndex((m) => m.role === "user" && m.content?.includes("QUOTA TASK"))
            const done = b.messages.slice(from).filter((m) => m.role === "tool").length
            const step = steps[done]
            if (!step) return sse(res, completionChunks(["Done."], {}))
            sse(res, call(step[0], step[1], `quota_${done}`))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
        model: { context: 200000 }
      })
      const chat = yield* api.CreateWorkshop({ title: "Quota" })
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "commands.network", mode: "off" })
      const events: Array<ChatEvent> = []
      yield* api.SubscribeChat({ chatId: chat.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      yield* eventually(() => events.length > 0)
      const sent = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: chat.activeLeafSlotId,
          branch: false,
          content: "QUOTA TASK: fill the files."
        })
      )
      const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      const id = reply.entry.version.id
      yield* eventually(() => finished(events, id) !== undefined, 90_000)
      const results = requests
        .at(-1)!
        .messages.filter((m) => m.role === "tool")
        .map((m) => unquoteToolData(m.content ?? ""))
      // Under the quota, a command runs; the one that goes over runs (a command can't be stopped
      // mid-write) and says so; after it, commands and writes are refused, reads still work.
      assert.include(results[0], "ran-1")
      assert.include(results[1], "ran-2")
      assert.match(results[1]!, /Your files use [\d.]+ MB of 1 MB\./)
      assert.notInclude(results[2], "ran-3")
      assert.match(
        results[2]!,
        /Your files use [\d.]+ MB of 1 MB\. Delete files you don't need to run commands again\./
      )
      assert.match(results[3]!, /Delete files you don't need to write files again\./)
      assert.include(results[4], "small")
      const usage = yield* api.GetFilesUsage({})
      assert.isTrue(usage.over)
      assert.strictEqual(usage.quotaBytes, 2 ** 20)
      assert.isAtLeast(usage.filesBytes, 3_000_000)
      // The single-mode user is the admin: its own quota raised, usage is under it again.
      const me = yield* api.Whoami()
      const lifted = yield* api.SetFilesQuota({ userId: me.id, quotaBytes: 100 * 2 ** 20 })
      assert.isFalse(lifted.over)
      assert.strictEqual(lifted.quotaBytes, 100 * 2 ** 20)
      const files = yield* WorkshopFiles
      yield* files.quota.check(me.id, 1000, "write files")
      // Back to the instance default: over again.
      const back = yield* api.SetFilesQuota({ userId: me.id, quotaBytes: null })
      assert.isTrue(back.over)
      const refused = yield* Effect.exit(files.quota.check(me.id, 0, "run commands"))
      assert.strictEqual(refused._tag, "Failure")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  },
  120_000
)

it.live("retention removes old versions, and the media only they named", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client()
    const me = (yield* api.Whoami()).id as UserId
    const writer = yield* Writer
    const other = (yield* writer.CreateUser({
      handle: "quota-other",
      displayName: "Other",
      role: "user",
      passwordHash: "synthetic"
    })).id
    const reader = yield* Reader
    const version = (sha256: string, byteSize: number) => ({
      path: "/files/a.txt",
      inode: null,
      sha256,
      mime: "application/octet-stream",
      byteSize,
      origin: "agent"
    })
    const shared = "a".repeat(64)
    const own = "b".repeat(64)
    yield* writer.RecordFileVersions({ userId: me, versions: [version(shared, 100), version(own, 50)] })
    yield* writer.RecordFileVersions({ userId: other, versions: [version(shared, 100)] })
    assert.strictEqual(yield* reader.FileVersionBytes({ userId: me }), 150)
    // Nothing is old yet.
    const none = yield* writer.PruneFileVersions({ before: Date.now() - 30 * 86_400_000, limit: 100 })
    assert.deepStrictEqual(none, { versions: 0, media: 0 })
    // One account's: its two versions go; the content the other account's version names stays.
    const mine = yield* writer.PruneFileVersions({ userId: me, before: Date.now() + 1, limit: 100 })
    assert.deepStrictEqual(mine, { versions: 2, media: 1 })
    assert.strictEqual(yield* reader.FileVersionBytes({ userId: me }), 0)
    assert.strictEqual(yield* reader.FileVersionBytes({ userId: other }), 100)
    assert.isTrue(yield* reader.IsMediaRecorded({ sha256: shared }))
    assert.isFalse(yield* reader.IsMediaRecorded({ sha256: own }))
    // Everyone's, in batches of one.
    const first = yield* writer.PruneFileVersions({ before: Date.now() + 1, limit: 1 })
    assert.deepStrictEqual(first, { versions: 1, media: 1 })
    assert.isFalse(yield* reader.IsMediaRecorded({ sha256: shared }))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

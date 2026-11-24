// The Files quota and version retention (spec/FILES-AND-ENVIRONMENT.md §1.2, §1.3): a run over
// a small quota is refused new writes and commands with how much it uses, the usage RPC says
// so, an admin's quota lifts it, and retention removes old versions and the media only they
// named. Synthetic data only.
import { chmod, link, lstat, mkdir, rename, symlink, truncate, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { makeFilesQuota, measureTree, parseByteSize } from "../src/files/quota.ts"
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

describe("a walk that stops at its limits", () => {
  it.live("isn't room: writes and commands are refused, not let past an uncounted rest", () =>
    Effect.gen(function* () {
      const root = tempDir("quota-partial")
      yield* Effect.promise(async () => {
        await mkdir(join(root, "files"), { recursive: true })
        for (let i = 0; i < 20; i++) await writeFile(join(root, "files", `f${i}`), "")
      })
      const quota = makeFilesQuota({
        reader: {
          GetAppSetting: () => Effect.succeed(null),
          FileVersionBytes: () => Effect.succeed(0)
        } as never,
        writer: { PruneFileVersions: () => Effect.succeed({ versions: 0, attachments: 0, media: 0 }) } as never,
        folders: () => ({ filesRoot: join(root, "files"), home: join(root, "home") }),
        defaultBytes: 10 * 2 ** 30,
        walkMaxEntries: 5
      })
      const refused = yield* Effect.exit(quota.check("u", 1, "write files"))
      assert.strictEqual(refused._tag, "Failure")
      assert.match(String(yield* quota.afterCommand("u")), /couldn't be fully counted/)
    })
  )
})

describe("the cached figure between walks", () => {
  const setup = async (name: string) => {
    const root = tempDir(name)
    await mkdir(join(root, "files", "sub"), { recursive: true })
    await writeFile(join(root, "files", "sub", "a"), Buffer.alloc(100_000, 1))
    let walks = 0
    /** The next walk stops after reading the folders, until `gate.open()`. */
    const gate: { reached: Promise<void>; open: () => void; arm: () => void } = {
      reached: Promise.resolve(),
      open: () => undefined,
      arm: () => undefined
    }
    let armed: { reached: () => void; wait: Promise<void> } | null = null
    gate.arm = () => {
      let reached!: () => void
      let open!: () => void
      gate.reached = new Promise<void>((resolve) => (reached = resolve))
      armed = { reached, wait: new Promise<void>((resolve) => (open = resolve)) }
      gate.open = open
    }
    let afterRead: ((pending: Map<number, number> | undefined) => void) | undefined
    const quota = makeFilesQuota({
      afterRead: (pending) => afterRead?.(pending),
      reader: {
        GetAppSetting: () => Effect.succeed(null),
        FileVersionBytes: () =>
          Effect.promise(async () => {
            walks++
            const mine = armed
            armed = null
            if (mine) {
              mine.reached()
              await mine.wait
            }
            return 0
          })
      } as never,
      writer: { PruneFileVersions: () => Effect.succeed({ versions: 0, attachments: 0, media: 0 }) } as never,
      folders: () => ({ filesRoot: join(root, "files"), home: join(root, "home") }),
      defaultBytes: 10 * 2 ** 30
    })
    return {
      quota,
      walks: () => walks,
      gate,
      root,
      onRead: (fn: typeof afterRead) => {
        afterRead = fn
      }
    }
  }

  it.live("reading usage again walks nothing; writes raise it and frees lower it", () =>
    Effect.gen(function* () {
      const { quota, walks } = yield* Effect.promise(() => setup("quota-cached"))
      const first = yield* quota.usage("u")
      yield* quota.usage("u")
      yield* quota.usage("u")
      assert.strictEqual(walks(), 1)
      quota.wrote("u", 5_000)
      assert.strictEqual((yield* quota.usage("u")).usedBytes, first.usedBytes + 5_000)
      const token = quota.freed("u", 30_000)
      assert.strictEqual((yield* quota.usage("u")).usedBytes, first.usedBytes - 25_000)
      // A removal that didn't happen gives it back; it never goes below nothing.
      quota.unfreed("u", token)
      assert.strictEqual((yield* quota.usage("u")).usedBytes, first.usedBytes + 5_000)
      quota.freed("u", 10 * 2 ** 30)
      assert.strictEqual((yield* quota.usage("u")).usedBytes, 0)
      assert.strictEqual(walks(), 1)
      // A measurement sees the folder itself and drops both.
      const measured = yield* quota.measure("u")
      assert.strictEqual((yield* quota.usage("u")).usedBytes, measured.usedBytes)
    })
  )

  it.live("a walk keeps what landed while it ran, and drops what it began with", () =>
    Effect.gen(function* () {
      const { quota, gate } = yield* Effect.promise(() => setup("quota-race"))
      yield* quota.usage("u")
      quota.wrote("u", 500)
      gate.arm()
      const walking = yield* Effect.forkChild(quota.measure("u"))
      yield* Effect.promise(() => gate.reached)
      // A write that lands after the walk read the folders is in no figure the walk makes.
      quota.wrote("u", 1_000)
      gate.open()
      const measured = yield* Fiber.join(walking)
      assert.strictEqual((yield* quota.usage("u")).usedBytes, measured.usedBytes + 1_000)
    })
  )

  it.live("a command's walk starts after the command, not joined from before it", () =>
    Effect.gen(function* () {
      const { quota, gate, root, walks } = yield* Effect.promise(() => setup("quota-command"))
      const before = yield* quota.usage("u")
      gate.arm()
      const sweeping = yield* Effect.forkChild(quota.measure("u"))
      yield* Effect.promise(() => gate.reached)
      // The command writes its output while the sweep is mid-walk.
      yield* Effect.promise(() => writeFile(join(root, "files", "out.bin"), Buffer.alloc(300_000, 2)))
      const after = yield* Effect.forkChild(quota.afterCommand("u"))
      gate.open()
      yield* Fiber.join(sweeping)
      yield* Fiber.join(after)
      assert.strictEqual(walks(), 3)
      assert.isAtLeast((yield* quota.usage("u")).usedBytes, before.usedBytes + 300_000)
    })
  )

  it.live("a give-back during a walk isn't taken off twice, and a write beside it stays", () =>
    Effect.gen(function* () {
      const { quota, gate } = yield* Effect.promise(() => setup("quota-giveback"))
      const first = yield* quota.usage("u")
      const upload = quota.hold("u")
      assert.isTrue(upload.reserve(1_000, first.usedBytes + 10_000))
      gate.arm()
      const walking = yield* Effect.forkChild(quota.measure("u"))
      yield* Effect.promise(() => gate.reached)
      // The upload aborts mid-walk, and another write lands.
      upload.release()
      quota.wrote("u", 500)
      gate.open()
      const measured = yield* Fiber.join(walking)
      assert.strictEqual((yield* quota.usage("u")).usedBytes, measured.usedBytes + 500)
    })
  )

  it.live("a hold gives back exactly what is still counted, however many walks came between", () =>
    Effect.gen(function* () {
      const { quota, gate } = yield* Effect.promise(() => setup("quota-hold"))
      const first = yield* quota.usage("u")
      const room = first.usedBytes + 100_000
      const upload = quota.hold("u")
      assert.isTrue(upload.reserve(1_000, room))
      // A walk ends mid-upload: it took the first 1,000 off. Then more arrives.
      const one = yield* quota.measure("u")
      assert.isTrue(upload.reserve(400, room))
      assert.strictEqual((yield* quota.usage("u")).usedBytes, one.usedBytes + 400)
      // A second walk starts, takes more during it, and ends; the upload then fails.
      gate.arm()
      const walking = yield* Effect.forkChild(quota.measure("u"))
      yield* Effect.promise(() => gate.reached)
      assert.isTrue(upload.reserve(300, room))
      gate.open()
      const two = yield* Fiber.join(walking)
      assert.strictEqual((yield* quota.usage("u")).usedBytes, two.usedBytes + 300)
      upload.release()
      assert.strictEqual((yield* quota.usage("u")).usedBytes, two.usedBytes)
      // Giving back twice, or after everything is gone, changes nothing.
      upload.release()
      assert.strictEqual((yield* quota.usage("u")).usedBytes, two.usedBytes)
    })
  )

  it.live("an upload renamed into place during a walk stays counted", () =>
    Effect.gen(function* () {
      const { quota, gate } = yield* Effect.promise(() => setup("quota-landed"))
      const first = yield* quota.usage("u")
      const upload = quota.hold("u")
      assert.isTrue(upload.reserve(5_000, first.usedBytes + 100_000))
      gate.arm()
      const walking = yield* Effect.forkChild(quota.measure("u"))
      yield* Effect.promise(() => gate.reached)
      // The walk listed its temporary name and found it gone: the file isn't in its figure.
      upload.landed()
      gate.open()
      const measured = yield* Fiber.join(walking)
      assert.strictEqual((yield* quota.usage("u")).usedBytes, measured.usedBytes + 5_000)
      // The next walk, which sees it on disk, takes the entry off.
      const next = yield* quota.measure("u")
      assert.strictEqual((yield* quota.usage("u")).usedBytes, next.usedBytes)
    })
  )

  for (const counted of [3_000, 5_000]) {
    it.live(`retains only unmeasured upload bytes when a walk counted ${counted} bytes under the temporary name`, () =>
      Effect.gen(function* () {
        const { quota, gate, root } = yield* Effect.promise(() => setup("quota-upload-inode"))
        const first = yield* quota.usage("u")
        const upload = quota.hold("u")
        assert.isTrue(upload.reserve(counted, first.quotaBytes))
        const temporary = join(root, "files", ".upload.rp-tmp")
        yield* Effect.promise(() => writeFile(temporary, Buffer.alloc(counted)))
        const file = yield* Effect.promise(() => lstat(temporary))
        gate.arm()
        const walking = yield* Effect.forkChild(quota.measure("u"))
        yield* Effect.promise(() => gate.reached)
        assert.isTrue(upload.reserve(5_000 - counted, first.quotaBytes))
        yield* Effect.promise(() => truncate(temporary, 5_000))
        yield* Effect.promise(() => rename(temporary, join(root, "files", "upload")))
        upload.landed(file)
        gate.open()
        const measured = yield* Fiber.join(walking)
        assert.strictEqual((yield* quota.usage("u")).usedBytes, measured.usedBytes + 5_000 - counted)
      })
    )
  }

  it.live("an entry found smaller than a walk began with is logged and removed, not a failure", () =>
    Effect.gen(function* () {
      const { quota, onRead } = yield* Effect.promise(() => setup("quota-shrunk"))
      yield* quota.usage("u")
      quota.wrote("u", 800)
      onRead((pending) => {
        for (const id of pending!.keys()) pending!.set(id, 300)
      })
      const measured = yield* quota.measure("u")
      onRead(undefined)
      assert.strictEqual((yield* quota.usage("u")).usedBytes, measured.usedBytes)
      // Writes after it count as ever.
      quota.wrote("u", 50)
      assert.strictEqual((yield* quota.usage("u")).usedBytes, measured.usedBytes + 50)
    })
  )

  it.live("one account's failed measurement doesn't stop the sweep", () =>
    Effect.gen(function* () {
      const root = tempDir("quota-sweep")
      yield* Effect.promise(() => mkdir(join(root, "files"), { recursive: true }))
      const measuredFor: Array<string> = []
      const quota = makeFilesQuota({
        reader: {
          GetAppSetting: () => Effect.succeed(null),
          FileVersionBytes: ({ userId }: { userId: string }) =>
            userId === "bad" && measuredFor.includes("bad")
              ? Effect.die(new Error("boom"))
              : Effect.sync(() => (measuredFor.push(userId), 0))
        } as never,
        writer: { PruneFileVersions: () => Effect.succeed({ versions: 0, attachments: 0, media: 0 }) } as never,
        folders: () => ({ filesRoot: join(root, "files"), home: join(root, "home") }),
        defaultBytes: 2 ** 30
      })
      yield* quota.usage("bad")
      yield* quota.usage("good")
      measuredFor.length = 0
      measuredFor.push("bad")
      yield* quota.remeasureActive
      assert.deepStrictEqual(measuredFor, ["bad", "good"])
    })
  )

  it.live("a free taken off by a walk isn't given back after it", () =>
    Effect.gen(function* () {
      const { quota } = yield* Effect.promise(() => setup("quota-unfree"))
      yield* quota.usage("u")
      const token = quota.freed("u", 40_000)
      const measured = yield* quota.measure("u")
      quota.freed("u", 1_000)
      quota.unfreed("u", token)
      assert.strictEqual((yield* quota.usage("u")).usedBytes, measured.usedBytes - 1_000)
    })
  )

  it.live("freed room is room for a streaming write", () =>
    Effect.gen(function* () {
      const { quota } = yield* Effect.promise(() => setup("quota-room"))
      const now = yield* quota.usage("u")
      const held = quota.hold("u")
      assert.isFalse(held.reserve(1_000, now.usedBytes))
      quota.freed("u", 2_000)
      assert.isTrue(held.reserve(1_000, now.usedBytes))
    })
  )
})

describe("measuring", () => {
  it("reads sizes with binary units", () => {
    assert.strictEqual(parseByteSize("10G"), 10 * 2 ** 30)
    assert.strictEqual(parseByteSize("512M"), 512 * 2 ** 20)
    assert.strictEqual(parseByteSize("1.5GiB"), 1.5 * 2 ** 30)
    assert.strictEqual(parseByteSize("2048"), 2048)
    assert.isNull(parseByteSize("ten gigs"))
    assert.isNull(parseByteSize("-1G"))
  })

  it.live.skipIf(process.getuid?.() === 0)(
    "marks an unreadable directory as partial and a missing path as complete",
    () =>
      Effect.promise(async () => {
        const root = tempDir("measure-unreadable")
        const folder = join(root, "restricted")
        await mkdir(folder)
        await writeFile(join(folder, "hidden"), "synthetic contents")
        await chmod(folder, 0)
        try {
          assert.isTrue((await measureTree(root)).partial)
          assert.isFalse((await measureTree(join(root, "missing"))).partial)
        } finally {
          await chmod(folder, 0o700)
        }
      })
  )

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
      // What deleting frees for sure leaves out a file another link keeps.
      const sole = await measureTree(root, undefined, undefined, true)
      assert.isBelow(sole.bytes, measured.bytes - 2 ** 20 + 4096 * 4)
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
        /Your files use [\d.]+ MB of 1 MB\. Delete files you don't need and empty the bin to run commands again\./
      )
      assert.match(results[3]!, /Delete files you don't need and empty the bin to write files again\./)
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
    assert.deepStrictEqual(none, { versions: 0, attachments: 0, media: 0 })
    // One account's: its two versions go; the content the other account's version names stays.
    const mine = yield* writer.PruneFileVersions({ userId: me, before: Date.now() + 1, limit: 100 })
    assert.deepStrictEqual(mine, { versions: 2, attachments: 0, media: 1 })
    assert.strictEqual(yield* reader.FileVersionBytes({ userId: me }), 0)
    assert.strictEqual(yield* reader.FileVersionBytes({ userId: other }), 100)
    assert.isTrue(yield* reader.IsMediaRecorded({ sha256: shared }))
    assert.isFalse(yield* reader.IsMediaRecorded({ sha256: own }))
    // Everyone's, in batches of one.
    const first = yield* writer.PruneFileVersions({ before: Date.now() + 1, limit: 1 })
    assert.deepStrictEqual(first, { versions: 1, attachments: 0, media: 1 })
    assert.isFalse(yield* reader.IsMediaRecorded({ sha256: shared }))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

// The workshop's file tools and commands against the real agent, workers and sandbox
// (spec/FILES-AND-ENVIRONMENT.md §5, §7): a scripted model writes, reads, edits and runs a
// command; the files land in the account's Files, each change records its effect, Undo puts a
// file back, and the capability rows include the per-workshop switches. Synthetic data only.
import { mkdir, readdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { assert, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { completionChunks, sse, startMockProvider, type Recorded } from "./support/mockProvider.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { unquoteToolData } from "./support/toolData.ts"
import { linuxBwrap } from "../src/sandbox/linuxBwrap.ts"
import { WorkshopFiles } from "../src/files/WorkshopFiles.ts"

interface Body {
  messages: Array<{ role: string; content?: string }>
  tools?: Array<{ function: { name: string } }>
}
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

const commands = (await linuxBwrap.available()).ok

it.live(
  "writes, reads, edits and runs a command in the account's files, with effects and Undo",
  () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const requests: Array<Body> = []
      const steps: Array<[string, unknown]> = [
        ["write_file", { path: "notes/plan.md", content: "Chapter one\nThe lighthouse keeper waits.\n" }],
        ["read_file", { path: "/files/notes/plan.md" }],
        ["edit_file", { path: "notes/plan.md", old_string: "waits", new_string: "climbs the stairs" }],
        ["write_file", { path: "notes/plan.md", content: "unread overwrite" }],
        ["list_files", { path: "/files", depth: 2 }],
        ["read_file", { path: "../../etc/passwd" }],
        ...(commands
          ? ([
              ["bash", { command: "cd notes && cat plan.md && echo made > made.txt && wc -l < plan.md" }],
              ["bash", { command: "pwd" }]
            ] as Array<[string, unknown]>)
          : []),
        ["write_file", { path: "/files/notes/scratch.md", content: "A separate scratch file." }]
      ]
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((r: Recorded, res) => {
            const b = r.body as unknown as Body
            if (!JSON.stringify(b.messages).includes("FILES TASK")) return sse(res, completionChunks(["Ready."], {}))
            requests.push(b)
            const from = b.messages.findLastIndex((m) => m.role === "user" && m.content?.includes("FILES TASK"))
            const done = b.messages.slice(from).filter((m) => m.role === "tool").length
            const step = steps[done]
            if (!step) return sse(res, completionChunks(["Done."], {}))
            sse(res, call(step[0], step[1], `files_${done}`))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
        model: { context: 200000 }
      })
      const chat = yield* api.CreateWorkshop({ title: "Files" })
      // The per-workshop switches: files, commands, and the internet for commands.
      const capabilities = yield* api.ListWorkshopCapabilities({ chatId: chat.id })
      const row = (id: string) => capabilities.find((c) => c.id === id)
      assert.strictEqual(row("files")?.mode, "allow")
      assert.strictEqual(row("commands")?.mode, "allow")
      assert.strictEqual(row("commands.network")?.mode, "allow")
      assert.deepStrictEqual(row("commands.network")?.modes, ["off", "allow"])
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
          content: "FILES TASK: keep a plan in notes/plan.md."
        })
      )
      const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      const id = reply.entry.version.id
      yield* eventually(() => finished(events, id) !== undefined, 90_000)
      assert.strictEqual(finished(events, id)!.status, "complete")
      const offered = requests[0]!.tools!.map((t) => t.function.name)
      for (const name of ["read_file", "write_file", "edit_file", "list_files", "search_files", "bash"])
        assert.include(offered, name)
      const results = requests
        .at(-1)!
        .messages.filter((m) => m.role === "tool")
        .map((m) => unquoteToolData(m.content ?? ""))
      assert.include(results[0], "Created /files/notes/plan.md")
      assert.include(results[1], "The lighthouse keeper waits.")
      assert.include(results[2], "Edited /files/notes/plan.md: 1 replacement")
      // Replacing needs a read of the current content in this run; the edit counted as one.
      assert.include(results[3], "Replaced /files/notes/plan.md")
      assert.include(results[4], "notes/plan.md")
      assert.include(results[5], "outside your files")
      const me = yield* api.Whoami()
      const root = join(config.dataDir, "files", me.id)
      assert.strictEqual(yield* Effect.promise(() => readFile(join(root, "notes/plan.md"), "utf8")), "unread overwrite")
      if (commands) {
        assert.include(results[6], "exit: 0")
        assert.include(results[6], "unread overwrite")
        assert.include(results[6], "Directory after: /files/notes")
        assert.include(results[6], "created /files/notes/made.txt")
        assert.include(results[6], "Internet from commands is off in this workshop.")
        // The directory carries over to the next call in the run.
        assert.include(results[7], "/files/notes")
        assert.strictEqual(yield* Effect.promise(() => readFile(join(root, "notes/made.txt"), "utf8")), "made\n")
      }
      const effects = yield* api.ListVersionEffects({ versionId: id })
      // Newest first.
      const kinds = effects.map((e) => e.kind)
      assert.deepStrictEqual(
        effects.filter((e) => e.kind.startsWith("file.") && e.targetId === "/files/notes/plan.md").map((e) => e.kind),
        ["file.write", "file.edit", "file.create"]
      )
      if (commands) assert.strictEqual(kinds.filter((k) => k === "shell.run").length, 2)
      const shell = effects.find((e) => e.kind === "shell.run")
      if (shell) assert.isNull(shell.undo)
      // Undo newest first: the overwrite, then the edit, then the creation.
      const undo = (kind: string, target = "/files/notes/plan.md") => {
        const effect = effects.find((e) => e.kind === kind && e.targetId === target)!
        return api.UndoRolloutEffect({ rolloutId: effect.rolloutId, toolCallId: effect.toolCallId, seq: effect.seq })
      }
      // Undo never writes through a link swapped in after the change: not for the file, and not
      // for a folder on its path, even when the link's target holds the same content.
      const outside = join(config.dataDir, "outside")
      yield* Effect.promise(async () => {
        await mkdir(outside, { recursive: true })
        await writeFile(join(outside, "plan.md"), "unread overwrite")
        await rename(join(root, "notes/plan.md"), join(root, "notes/plan.real"))
        await symlink(join(outside, "plan.md"), join(root, "notes/plan.md"))
      })
      assert.isTrue((yield* Effect.exit(undo("file.write")))._tag === "Failure")
      yield* Effect.promise(async () => {
        await unlink(join(root, "notes/plan.md"))
        await rename(join(root, "notes/plan.real"), join(root, "notes/plan.md"))
        await rename(join(root, "notes"), join(root, "notes.real"))
        await symlink(outside, join(root, "notes"))
      })
      assert.isTrue((yield* Effect.exit(undo("file.write")))._tag === "Failure")
      yield* Effect.promise(async () => {
        await unlink(join(root, "notes"))
        await rename(join(root, "notes.real"), join(root, "notes"))
      })
      assert.strictEqual(yield* Effect.promise(() => readFile(join(outside, "plan.md"), "utf8")), "unread overwrite")
      assert.deepStrictEqual(yield* Effect.promise(() => readdir(outside)), ["plan.md"])
      // The edit can't be undone before the overwrite that came after it: the file changed since.
      const early = yield* Effect.exit(undo("file.edit"))
      assert.isTrue(early._tag === "Failure")
      const { quota } = yield* WorkshopFiles
      const beforeOverwrite = yield* quota.measure(me.id)
      yield* undo("file.write")
      const edited = "Chapter one\nThe lighthouse keeper climbs the stairs.\n"
      assert.strictEqual((yield* quota.usage(me.id)).usedBytes, beforeOverwrite.usedBytes + Buffer.byteLength(edited))
      assert.strictEqual(yield* Effect.promise(() => readFile(join(root, "notes/plan.md"), "utf8")), edited)
      yield* undo("file.edit")
      assert.strictEqual(
        yield* Effect.promise(() => readFile(join(root, "notes/plan.md"), "utf8")),
        "Chapter one\nThe lighthouse keeper waits.\n"
      )
      const undone = yield* undo("file.create")
      assert.isNotNull(undone.undoneAt)
      assert.isFalse(existsSync(join(root, "notes/plan.md")))
      const beforeCreationUndo = yield* quota.measure(me.id)
      yield* undo("file.create", "/files/notes/scratch.md")
      assert.isFalse(existsSync(join(root, "notes/scratch.md")))
      assert.strictEqual((yield* quota.usage(me.id)).usedBytes, beforeCreationUndo.usedBytes)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  },
  120_000
)

// Plugin working copies in Files and the app's source (spec/FILES-AND-ENVIRONMENT.md §5.3, §3.6)
// against the real agent, workers, plugin host and sandbox: plugin_create makes
// /files/Plugins/<id>; the file tools change it and `plugin_commit from: "files"` commits it
// through the repository's checks; a repository change brings the copy up to date and says
// which uncommitted copy changes it replaced (kept as versions); Undo follows too; /app-source
// reads but never writes. Synthetic data and a scripted model only.
import { readFile, symlink, unlink } from "node:fs/promises"
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

interface Body {
  messages: Array<{ role: string; content?: string }>
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
const copy = "/files/Plugins/notes-chip"

it.live(
  "makes, commits and follows a plugin's working copy in Files, and reads the app's source",
  () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const requests: Array<Body> = []
      let root = ""
      const steps: Array<[string, unknown] | (() => Promise<void>)> = [
        ["plugin_create", { id: "notes-chip", name: "Notes chip", runs: "browser" }],
        ["read_file", { path: `${copy}/src/client.tsx` }],
        [
          "edit_file",
          { path: `${copy}/src/client.tsx`, old_string: "() => {}", new_string: "() => { /* from files */ }" }
        ],
        ["plugin_commit", { plugin: "notes-chip", message: "From the working copy", from: "files" }],
        ["plugin_read", { plugin: "notes-chip", path: "src/client.tsx" }],
        // An untracked file of the copy, and a change there that isn't committed.
        ["write_file", { path: `${copy}/README.md`, content: "draft\n" }],
        ["read_file", { path: `${copy}/test/plugin.test.ts` }],
        ["edit_file", { path: `${copy}/test/plugin.test.ts`, old_string: "1 + 1, 2", new_string: "2 + 2, 4" }],
        ["plugin_edit", { plugin: "notes-chip", path: "test/plugin.test.ts", old_str: "1 + 1", new_str: "3 - 1" }],
        // The repository now has an edit that isn't committed: committing the copy would lose it.
        ["plugin_commit", { plugin: "notes-chip", message: "Lose it", from: "files" }],
        ["plugin_commit", { plugin: "notes-chip", message: "The edit" }],
        // A link in the copy is refused, never followed.
        ["plugin_commit", { plugin: "notes-chip", message: "Linked", from: "files" }],
        ["read_file", { path: "/app-source/SOURCE.md" }],
        ["write_file", { path: "/app-source/x.txt", content: "x" }],
        ["list_files", { path: "/app-source/packages/plugin-api/src" }],
        ...(commands
          ? ([
              [
                "bash",
                {
                  command: `head -1 /app-source/SOURCE.md && test -d ${copy}/.git && echo has-git; touch /app-source/x 2>/dev/null || echo read-only`
                }
              ]
            ] as Array<[string, unknown]>)
          : [])
      ]
      const linkAt = steps.findIndex((s) => Array.isArray(s) && (s[1] as { message?: string }).message === "Linked")
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider(async (r: Recorded, res) => {
            const b = r.body as unknown as Body
            if (!JSON.stringify(b.messages).includes("COPY TASK")) return sse(res, completionChunks(["Ready."], {}))
            requests.push(b)
            const from = b.messages.findLastIndex((m) => m.role === "user" && m.content?.includes("COPY TASK"))
            const done = b.messages.slice(from).filter((m) => m.role === "tool").length
            const step = steps[done]
            if (!step) return sse(res, completionChunks(["Done."], {}))
            // Before the linked commit, the copy gets a link a command could plant.
            if (done === linkAt) await symlink("/etc/passwd", join(root, "Plugins/notes-chip/src/passwd.ts"))
            sse(res, call((step as [string, unknown])[0], (step as [string, unknown])[1], `copy_${done}`))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
        model: { context: 200000 }
      })
      const me = yield* api.Whoami()
      root = join(config.dataDir, "files", me.id)
      const chat = yield* api.CreateWorkshop({ title: "Plugin copy" })
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
          content: "COPY TASK: work on the notes chip plugin in its working copy."
        })
      )
      const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      const id = reply.entry.version.id
      yield* eventually(() => finished(events, id) !== undefined, 120_000)
      assert.strictEqual(finished(events, id)!.status, "complete")
      const results = requests
        .at(-1)!
        .messages.filter((m) => m.role === "tool")
        .map((m) => unquoteToolData(m.content ?? ""))
      const local = (path: string) => readFile(join(root, "Plugins/notes-chip", path), "utf8")
      // The copy was made beside the repository.
      assert.include(results[0], `"workingCopy":"${copy}"`)
      assert.include(results[1], "export const activate")
      assert.include(results[2], "Edited")
      // Committed from the copy: the repository has the edit.
      assert.match(results[3]!, /"commit":"[a-f0-9]{40}"/)
      assert.include(results[4], "from files")
      // The repository's edit replaced the copy's uncommitted change, which is kept as a version.
      assert.include(results[8], '"workingCopyOverwritten":["test/plugin.test.ts"]')
      assert.include(yield* Effect.promise(() => local("test/plugin.test.ts")), "3 - 1")
      // A file only the copy has stays.
      assert.strictEqual(yield* Effect.promise(() => local("README.md")), "draft\n")
      assert.include(results[9], "aren't committed")
      assert.match(results[10]!, /"commit":"[a-f0-9]{40}"/)
      assert.include(results[11], "is a link or a special file")
      assert.include(results[12], "read-only copy")
      assert.include(results[13], "/app-source is read-only")
      assert.include(results[14], "client.ts")
      if (commands) {
        assert.include(results[15], "# The app's source")
        assert.include(results[15], "has-git")
        assert.include(results[15], "read-only")
      }
      // The version kept of the replaced change.
      const versions = yield* api.ListVersionEffects({ versionId: id })
      assert.isTrue(versions.some((e) => e.kind === "plugin.write"))
      // Undo of the newest commit (a revert commit) brings the copy back too.
      yield* Effect.promise(() => unlink(join(root, "Plugins/notes-chip/src/passwd.ts")))
      const commit = versions.find((e) => e.kind === "plugin.commit")!
      yield* api.UndoRolloutEffect({ rolloutId: commit.rolloutId, toolCallId: commit.toolCallId, seq: commit.seq })
      assert.include(yield* Effect.promise(() => local("test/plugin.test.ts")), "1 + 1, 2")
      assert.isTrue(existsSync(join(root, "Plugins/notes-chip/README.md")))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  },
  180_000
)

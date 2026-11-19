// Background commands, kept output and shared folders in the sandbox
// (spec/FILES-AND-ENVIRONMENT.md §3.6, §5.1, §1.4) against the real agent, workers and sandbox:
// a long output is cut in the result and paged with bash_output; a background command runs
// while the reply goes on, its output and end are read with bash_output, and bash_stop stops
// one; a folder another account shared is bound read-only at /files/Shared/<owner>/<folder>,
// readable by the file tools, never made in the account's own Files, and left out when its
// owner swaps it for a link; Reset empties the home folder. Synthetic data and a scripted model.
import { mkdir, readdir, rename, symlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { assert, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { completionChunks, sse, startMockProvider, type Recorded } from "./support/mockProvider.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { unquoteToolData } from "./support/toolData.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
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
const idIn = (text: string) => /cmd_[a-f0-9]{16}/.exec(text)?.[0] ?? "cmd_0000000000000000"

it.live.skipIf(!commands)(
  "keeps whole output, runs and stops background commands, binds shared folders read-only and resets the home",
  () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const requests: Array<Body> = []
      const owner = join(config.dataDir, "files", "owner-mara")
      type Step = [string, unknown | ((results: Array<string>) => unknown)]
      const steps: Array<Step> = [
        ["bash", { command: "seq 1 40000" }],
        ["bash_output", (r: Array<string>) => ({ id: idIn(r[0]!), offset: 39_991, limit: 20 })],
        [
          "bash",
          {
            command: "for i in 1 2 3; do echo tick $i; sleep 0.3; done; echo made > bg.txt",
            run_in_background: true
          }
        ],
        ["bash", { command: "sleep 2; echo waited" }],
        ["bash_output", (r: Array<string>) => ({ id: idIn(r[2]!) })],
        ["bash", { command: "sleep 600", run_in_background: true }],
        ["bash_stop", (r: Array<string>) => ({ id: idIn(r[5]!) })],
        ["bash_output", (r: Array<string>) => ({ id: idIn(r[5]!) })],
        // The shared folder: read by the file tools, read-only in commands.
        ["read_file", { path: "/files/Shared/mara/notes/hello.txt" }],
        ["write_file", { path: "/files/Shared/mara/notes/new.txt", content: "x" }],
        [
          "bash",
          {
            command:
              "cat /files/Shared/mara/notes/hello.txt; (echo x > /files/Shared/mara/notes/new.txt) 2>/dev/null || echo refused-write; echo y > ~/installed.txt"
          }
        ],
        // The owner swaps the folder for a link: the next command doesn't see the link's target.
        ["bash", { command: "ls /files/Shared/mara/notes 2>&1; cat /files/Shared/mara/notes/passwd 2>&1 | head -1" }]
      ]
      const linkAt = steps.length - 1
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider(async (r: Recorded, res) => {
            const b = r.body as unknown as Body
            if (!JSON.stringify(b.messages).includes("JOBS TASK")) return sse(res, completionChunks(["Ready."], {}))
            requests.push(b)
            const from = b.messages.findLastIndex((m) => m.role === "user" && m.content?.includes("JOBS TASK"))
            const results = b.messages
              .slice(from)
              .filter((m) => m.role === "tool")
              .map((m) => unquoteToolData(m.content ?? ""))
            const step = steps[results.length]
            if (!step) return sse(res, completionChunks(["Done."], {}))
            if (results.length === linkAt) {
              await rename(join(owner, "notes"), join(owner, "notes.real"))
              await symlink("/etc", join(owner, "notes"))
            }
            const args = typeof step[1] === "function" ? (step[1] as (r: Array<string>) => unknown)(results) : step[1]
            sse(res, call(step[0], args, `jobs_${results.length}`))
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
      // Another account, Mara, shares her notes folder with this one to view (B3 makes these rows).
      yield* Effect.promise(async () => {
        await mkdir(join(owner, "notes"), { recursive: true })
        await writeFile(join(owner, "notes/hello.txt"), "hello from mara\n")
      })
      yield* fixtureSql(config.dataDir, [
        {
          sql: "INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('owner-mara', 'mara', 'Mara', 'user', 1)"
        },
        {
          sql: "INSERT INTO file_shares (id, owner_user_id, path, inode, grantee_user_id, mode, created_at) VALUES ('share-1', 'owner-mara', '/files/notes', NULL, ?, 'view', 1)",
          params: [me.id]
        }
      ])
      const chat = yield* api.CreateWorkshop({ title: "Jobs" })
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
          content: "JOBS TASK: try background commands."
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
      // The long output is cut in the result, and kept whole.
      assert.include(results[0], "the whole output is kept: bash_output id cmd_")
      assert.include(results[1], "Lines 39991–40000 of 40,000")
      assert.include(results[1], "\n40000")
      // The background command started at once, and its output and end were read later.
      assert.include(results[2], "Started in the background as cmd_")
      assert.include(results[3], "waited")
      assert.include(results[4], "exit: 0")
      assert.include(results[4], "tick 3")
      assert.include(results[4], "created /files/bg.txt")
      assert.include(results[6], "Stopped cmd_")
      assert.include(results[7], "stopped with bash_stop")
      // The shared folder.
      assert.include(results[8], "hello from mara")
      assert.include(results[9], "shared with you by another account")
      assert.include(results[10], "hello from mara")
      assert.include(results[10], "refused-write")
      assert.notInclude(results[11], "root:")
      const root = join(config.dataDir, "files", me.id)
      assert.isFalse(existsSync(join(root, "Shared")))
      assert.isFalse(existsSync(join(owner, "notes.real/new.txt")))
      // Reset empties the home folder; the files stay.
      const home = join(config.dataDir, "env-home", me.id)
      assert.include(yield* Effect.promise(() => readdir(home)), "installed.txt")
      const usage = yield* api.ResetCommandHome({})
      assert.deepStrictEqual(yield* Effect.promise(() => readdir(home)), [])
      assert.isTrue(existsSync(join(root, "bg.txt")))
      assert.isNumber(usage.networkBytes)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  },
  180_000
)

// Subagents that work on files, milestone SA6 (spec/SUBAGENTS.md §2.5, §3.3): a `code` subagent
// works in the reply's folder, its file changes listed in Changes under its handle with Undo; with
// `copy: true` it works in its own copy (a git worktree on a new branch for a repository, else a
// file copy), its file tools stay inside the copy, and the copy is removed when it made no change
// and kept, with the report naming it, when it did. Copies are made in the sandbox, so they need
// bubblewrap; those tests skip without it. Synthetic data and a scripted provider only.
import type { ServerResponse } from "node:http"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { RolloutStep, SubagentRow } from "@dreamspan/shared/agent.ts"
import type { Chat, VersionId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { linuxBwrap } from "../src/sandbox/linuxBwrap.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"
import { unquoteToolData } from "./support/toolData.ts"

type Api = Effect.Success<ReturnType<typeof client>>
interface Message {
  readonly role: string
  readonly content?: unknown
}
interface Body {
  readonly messages: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string } }>
}
interface Call {
  readonly name: string
  readonly args: unknown
}

const TRIGGER = "Workshop task:"
const CHILD = "You are a subagent"
const commands = (await linuxBwrap.available()).ok

const toolCall = (name: string, args: unknown, id: string) => [
  {
    id: "cmpl-tool",
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
    id: "cmpl-tool",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]

const text = (m: Message | undefined) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""))
const isChild = (body: Body) => text(body.messages[0]).includes(CHILD)

/**
 * The reply calls `parent` in turn; each child runs the script its task names (`[[name]]`), then
 * reports. Calls are numbered per task, so every call id is unique.
 */
const scripted =
  (parent: ReadonlyArray<Call>, children: Readonly<Record<string, ReadonlyArray<Call>>>) =>
  (request: Recorded, res: ServerResponse) => {
    const body = request.body as unknown as Body
    const messages = body.messages
    if (isChild(body)) {
      // A follow-up (`message_agent`) runs `<name>:again`, counted from the message.
      const from = messages.findLastIndex((m) => text(m).includes("Message from the assistant that started you"))
      const name = `${/\[\[(\w+)\]\]/.exec(text(messages[1]))?.[1] ?? ""}${from >= 0 ? ":again" : ""}`
      const done = messages.slice(Math.max(0, from)).filter((m) => m.role === "tool").length
      const step = children[name]?.[done]
      return sse(
        res,
        step
          ? toolCall(step.name, step.args, `${name.replace(":", "-")}-${done}`)
          : completionChunks([`Report ${name}.`], {})
      )
    }
    if (!JSON.stringify(messages).includes(TRIGGER)) return sse(res, completionChunks(["Ready."], {}))
    const last = messages.findLastIndex((m) => m.role === "user" && text(m).includes(TRIGGER))
    const done = messages.slice(last).filter((m) => m.role === "tool").length
    const step = parent[done]
    sse(res, step ? toolCall(step.name, step.args, `parent-${done}`) : completionChunks(["Done."], {}))
  }

const setup = (parent: ReadonlyArray<Call>, children: Readonly<Record<string, ReadonlyArray<Call>>>) =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider(scripted(parent, children))),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
      model: { context: 200000 }
    })
    const chat = yield* api.CreateWorkshop({})
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    const me = yield* api.Whoami()
    return { mock, api, chat, events, me }
  })

const run = (api: Api, chat: Chat, events: ReadonlyArray<ChatEvent>, content: string) =>
  Effect.gen(function* () {
    const current = yield* api.GetChat({ chatId: chat.id })
    const sent = yield* posted(
      api.SendMessage({
        chatId: chat.id,
        parentSlotId: current.activeLeafSlotId,
        branch: false,
        content: `${TRIGGER} ${content}`
      })
    )
    const generated = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
    const versionId = generated.entry.version.id as VersionId
    yield* eventually(() => finished(events, versionId) !== undefined, 120_000)
    assert.strictEqual(finished(events, versionId)!.status, "complete")
    return versionId
  })

const bodies = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body as unknown as Body)
const results = (body: Body) => body.messages.filter((m) => m.role === "tool").map((m) => unquoteToolData(text(m)))
const childOf = (requests: ReadonlyArray<Recorded>, name: string) =>
  bodies(requests).filter((b) => isChild(b) && text(b.messages[1]).includes(`[[${name}]]`))
const rowsOf = (steps: ReadonlyArray<RolloutStep>) =>
  steps.flatMap((s): ReadonlyArray<SubagentRow> => (s.kind === "tool" && s.subagent ? [s.subagent] : []))

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], { encoding: "utf8" }).trim()

describe("subagents that work on files", () => {
  it.live("a code subagent works in the reply's folder; its changes are in Changes under its handle", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { api, chat, events, mock, me } = yield* setup(
        [{ name: "agent", args: { type: "code", task: "[[same]] Write the plan.", name: "plan" } }],
        {
          same: [
            { name: "write_file", args: { path: "notes/plan.md", content: "Step one.\n" } },
            ...(commands ? [{ name: "bash", args: { command: "pwd && cat notes/plan.md" } }] : [])
          ]
        }
      )
      const versionId = yield* run(api, chat, events, "write a plan")
      const [first] = childOf(mock.requests(), "same")
      // It reads where it works, and it has the file tools the reply has, never `agent`.
      assert.include(text(first!.messages[1]), "You work in /files, the assistant's own folder")
      const names = (first!.tools ?? []).map((t) => t.function.name)
      for (const name of ["read_file", "write_file", "edit_file", "list_files"]) assert.include(names, name)
      assert.notInclude(names, "agent")
      const root = join(config.dataDir, "files", me.id)
      assert.strictEqual(yield* Effect.promise(() => readFile(join(root, "notes/plan.md"), "utf8")), "Step one.\n")
      const last = childOf(mock.requests(), "same").at(-1)!
      assert.include(results(last)[0], "Created /files/notes/plan.md")
      if (commands) assert.include(results(last)[1], "Directory after: /files\n")
      // The row names the folder, and no copy.
      const [row] = rowsOf(yield* api.GetRolloutSteps({ versionId }))
      assert.strictEqual(row?.handle, "code-1")
      assert.strictEqual(row?.typeLabel, "Work on files")
      assert.strictEqual(row?.folder, "/files")
      assert.isUndefined(row?.copy)
      // Its change is the reply's, under its handle, with Undo.
      const effects = yield* api.ListRolloutEffects({ chatId: chat.id })
      const write = effects.find((e) => e.kind === "file.create")
      assert.strictEqual(write?.subagent?.handle, "code-1")
      yield* api.UndoRolloutEffect({ rolloutId: write!.rolloutId, toolCallId: write!.toolCallId, seq: write!.seq })
      assert.isFalse(existsSync(join(root, "notes/plan.md")))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live.skipIf(!commands)(
    "copy: a git worktree on a new branch; its file tools stay in it; kept with changes, removed without",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const setupRepo =
          "mkdir -p proj/src && cd proj && git init -q && echo one > src/a.txt && git add . && git -c user.email=t@example.com -c user.name=T commit -qm first && cd src"
        const { api, chat, events, mock, me } = yield* setup(
          [
            { name: "bash", args: { command: setupRepo } },
            { name: "agent", args: { type: "code", task: "[[changes]] Change a.", copy: true } },
            { name: "agent", args: { type: "code", task: "[[nothing]] Look only.", copy: true } },
            { name: "agent", args: { type: "research", task: "[[research]] Copy?", copy: true } }
          ],
          {
            changes: [
              { name: "read_file", args: { path: "a.txt" } },
              { name: "edit_file", args: { path: "a.txt", old_string: "one", new_string: "two" } },
              { name: "read_file", args: { path: "/files/proj/src/a.txt" } },
              { name: "bash", args: { command: "pwd && git status --porcelain" } }
            ],
            nothing: [{ name: "read_file", args: { path: "a.txt" } }]
          }
        )
        const versionId = yield* run(api, chat, events, "change a in a copy")
        const root = join(config.dataDir, "files", me.id)
        const changes = childOf(mock.requests(), "changes")
        const told = text(changes[0]!.messages[1])
        const path =
          /: (\/files\/\.subagents\/code-[a-z0-9]{6}), a git worktree on the branch (subagent\/code-[a-z0-9]{6})/.exec(
            told
          )
        assert.isNotNull(path, told)
        const [, copyPath, branch] = path!
        assert.include(told, `You start in ${copyPath}/src.`)
        const steps = results(changes.at(-1)!)
        assert.include(steps[0], "one")
        assert.include(steps[1], `Edited ${copyPath}/src/a.txt`)
        // Outside its copy, its file tools refuse; the original is untouched.
        assert.include(steps[2], "is outside your copy")
        assert.include(steps[3], `Directory after: ${copyPath}/src`)
        assert.include(steps[3], "M src/a.txt")
        assert.strictEqual(yield* Effect.promise(() => readFile(join(root, "proj/src/a.txt"), "utf8")), "one\n")
        const host = join(root, copyPath!.slice("/files/".length))
        assert.strictEqual(yield* Effect.promise(() => readFile(join(host, "src/a.txt"), "utf8")), "two\n")
        // The reply's results: kept with its branch named; the one with no change removed.
        const parent = bodies(mock.requests())
          .filter((b) => !isChild(b) && JSON.stringify(b.messages).includes(TRIGGER))
          .at(-1)!
        const out = parent.messages.filter((m) => m.role === "tool").map(text)
        assert.include(out[1], `Its copy, with its changes: ${copyPath} (branch ${branch}). Nothing was merged back.`)
        assert.include(out[2], "Its copy had no changes and was removed.")
        assert.include(out[3], "work on files, so it gets no copy")
        const rows = rowsOf(yield* api.GetRolloutSteps({ versionId }))
        const kept = rows.find((r) => r.copy?.path === copyPath)
        assert.deepStrictEqual(kept?.copy, { path: copyPath!, from: "/files/proj/src", branch: branch!, kept: true })
        const removed = rows.find((r) => r.copy && r.copy.path !== copyPath)
        assert.strictEqual(removed?.copy?.kept, false)
        assert.isFalse(existsSync(join(root, removed!.copy!.path.slice("/files/".length))))
        // The repository: the kept branch is there, the removed one's isn't.
        const branches = git(join(root, "proj"), "branch", "--format=%(refname:short)")
        assert.include(branches, branch!)
        assert.notInclude(branches, removed!.copy!.branch!)
        assert.include(git(join(root, "proj"), "worktree", "list"), copyPath!.slice("/files/".length))
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live.skipIf(!commands)("copy: a file copy of a folder that isn't a repository, removed when unchanged", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { api, chat, events, mock, me } = yield* setup(
        [
          { name: "bash", args: { command: "mkdir -p draft && echo text > draft/b.txt && cd draft" } },
          { name: "agent", args: { type: "general", task: "[[writer]] Add c.", copy: true } },
          { name: "agent", args: { type: "general", task: "[[reader]] Read b.", copy: true } }
        ],
        {
          writer: [{ name: "write_file", args: { path: "c.txt", content: "new\n" } }],
          reader: [{ name: "read_file", args: { path: "b.txt" } }]
        }
      )
      const versionId = yield* run(api, chat, events, "file copies")
      const root = join(config.dataDir, "files", me.id)
      const told = text(childOf(mock.requests(), "writer")[0]!.messages[1])
      assert.include(told, "You work in your own copy of /files/draft: /files/.subagents/general-")
      assert.notInclude(told, "worktree")
      const rows = rowsOf(yield* api.GetRolloutSteps({ versionId }))
      const [writer, reader] = rows
      assert.strictEqual(writer?.copy?.kept, true)
      assert.isUndefined(writer?.copy?.branch)
      const copied = join(root, writer!.copy!.path.slice("/files/".length))
      assert.strictEqual(yield* Effect.promise(() => readFile(join(copied, "b.txt"), "utf8")), "text\n")
      assert.strictEqual(yield* Effect.promise(() => readFile(join(copied, "c.txt"), "utf8")), "new\n")
      assert.isFalse(existsSync(join(root, "draft/c.txt")))
      assert.strictEqual(reader?.copy?.kept, false)
      assert.isFalse(existsSync(join(root, reader!.copy!.path.slice("/files/".length))))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live.skipIf(!commands)("a follow-up carries a subagent on in its copy, made again where it was removed", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { api, chat, events, mock, me } = yield* setup(
        [
          { name: "bash", args: { command: "mkdir -p notes && echo one > notes/a.txt && cd notes" } },
          { name: "agent", args: { type: "code", task: "[[later]] Read a.", copy: true } },
          { name: "message_agent", args: { agent: "code-1", message: "Now add b." } }
        ],
        {
          later: [{ name: "read_file", args: { path: "a.txt" } }],
          "later:again": [{ name: "write_file", args: { path: "b.txt", content: "bee\n" } }]
        }
      )
      const versionId = yield* run(api, chat, events, "carry on")
      const root = join(config.dataDir, "files", me.id)
      const rows = rowsOf(yield* api.GetRolloutSteps({ versionId }))
      const [first, again] = rows
      assert.strictEqual(first?.copy?.kept, false)
      // The same copy, made again from its folder, keeps what the follow-up wrote.
      assert.strictEqual(again?.copy?.path, first?.copy?.path)
      assert.strictEqual(again?.copy?.kept, true)
      const copied = join(root, again!.copy!.path.slice("/files/".length))
      assert.strictEqual(yield* Effect.promise(() => readFile(join(copied, "a.txt"), "utf8")), "one\n")
      assert.strictEqual(yield* Effect.promise(() => readFile(join(copied, "b.txt"), "utf8")), "bee\n")
      // The kept copy is a change of the subagent's, in Changes under its handle.
      const effects = yield* api.ListRolloutEffects({ chatId: chat.id })
      const kept = effects.find((e) => e.kind === "subagent.copy")
      assert.strictEqual(kept?.subagent?.handle, "code-1")
      assert.include(kept?.title, `at ${again!.copy!.path}`)
      assert.isNotEmpty(childOf(mock.requests(), "later"))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live.skipIf(!commands)("no copy goes through a link: the copies folder must be a folder of your files", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { api, chat, events, mock, me } = yield* setup(
        [
          { name: "bash", args: { command: "mkdir -p /home/user/elsewhere && ln -s /home/user/elsewhere .subagents" } },
          { name: "agent", args: { type: "code", task: "[[linked]] Anything.", copy: true } }
        ],
        { linked: [{ name: "read_file", args: { path: "x" } }] }
      )
      yield* run(api, chat, events, "linked copies folder")
      const parent = bodies(mock.requests())
        .filter((b) => !isChild(b) && JSON.stringify(b.messages).includes(TRIGGER))
        .at(-1)!
      const out = parent.messages.filter((m) => m.role === "tool").map(text)
      assert.include(out[1], "is a link, so no copy goes there")
      assert.isEmpty(childOf(mock.requests(), "linked"))
      const home = join(config.dataDir, "env-home", me.id, "elsewhere")
      assert.deepStrictEqual(yield* Effect.promise(() => readdir(home)), [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

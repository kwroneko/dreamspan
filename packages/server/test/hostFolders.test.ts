// Host folders and commands without a sandbox (spec/FILES-AND-ENVIRONMENT.md §3.7): which
// HOST_FOLDERS roots are kept and which folders can be chosen (no links, nothing of the app's
// own); then, against the real agent, workers and sandbox, an admin's workshop working in a
// folder on the server: the file tools read and write there (versioned, Undo), a sandboxed
// command starts there and changes it but can't see the app's data, and with the sandbox turned
// off (after the consent the capability carries) the next command can; another account is
// offered neither, and can't choose the folder. Synthetic data and a scripted model.
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { assert, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { client, login, posted, serverLayer, testConfig } from "./support/config.ts"
import { completionChunks, sse, startMockProvider, type Recorded } from "./support/mockProvider.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { unquoteToolData } from "./support/toolData.ts"
import { tempDir } from "./support/tempDir.ts"
import { linuxBwrap } from "../src/sandbox/linuxBwrap.ts"
import { makeHostFolders } from "../src/files/hostFolders.ts"

it.live("keeps allowed roots only and refuses links, other places and the app's own folders", () =>
  Effect.promise(async () => {
    const data = tempDir("hostdata")
    const root = tempDir("hostroot")
    await mkdir(join(root, "project/src"), { recursive: true })
    await symlink(join(root, "project"), join(root, "shortcut"))
    await symlink(data, join(root, "to-data"))
    const lines: Array<string> = []
    const folders = makeHostFolders([root, "/", "/etc", data, "relative", join(root, "missing")], [data], (line) =>
      lines.push(line)
    )
    assert.deepStrictEqual(await folders.roots(), [root])
    assert.strictEqual(lines.length, 5)
    const project = await folders.check(join(root, "project"))
    assert.strictEqual(project.path, join(root, "project"))
    assert.isNumber(project.inode)
    const refused = async (path: string) => (await folders.check(path).catch((error: Error) => error.message)) as string
    assert.include(await refused(join(root, "shortcut")), "goes through a link")
    assert.include(await refused(join(root, "to-data")), "goes through a link")
    assert.include(await refused("/etc"), "isn't in a folder the server's admin allows")
    assert.include(await refused(`${root}/project/../project`), "full path")
    assert.include(await refused(join(root, "nope")), "doesn't exist")
    const top = await folders.list(null)
    assert.deepStrictEqual(top.folders, [{ name: root, path: root }])
    const listed = await folders.list(root)
    // Links aren't listed as folders.
    assert.deepStrictEqual(
      listed.folders.map((f) => f.name),
      ["project"]
    )
    assert.strictEqual(listed.parent, "")
    assert.strictEqual((await folders.list(join(root, "project"))).parent, root)
    assert.isTrue(await folders.allows(join(root, "project/src/a.txt")))
    assert.isFalse(await folders.allows(join(data, "x")))
  })
)

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

it.live.skipIf(!commands)(
  "an admin's workshop works in a folder on the server, sandboxed and then without the sandbox",
  () => {
    const hostRoot = tempDir("hostfolders")
    const config = testConfig({ hostFolders: [hostRoot], allowUnsandboxedCommands: true })
    const project = join(hostRoot, "project")
    return Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await mkdir(project, { recursive: true })
        await writeFile(join(project, "README.md"), "A synthetic project.\n")
      })
      const requests: Array<Body> = []
      const api = yield* client()
      let chatId = ""
      const probe = `test -e ${config.dataDir} && echo sees-data || echo no-data`
      const steps: Array<[string, unknown]> = [
        ["read_file", { path: "README.md" }],
        ["write_file", { path: "notes.txt", content: "first\n" }],
        ["bash", { command: `pwd; echo made > made.txt; ${probe}` }],
        // Before this one the owner turns the sandbox off for the workshop.
        ["bash", { command: probe }]
      ]
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider(async (r: Recorded, res) => {
            const b = r.body as unknown as Body
            if (!JSON.stringify(b.messages).includes("HOST TASK")) return sse(res, completionChunks(["Ready."], {}))
            requests.push(b)
            const from = b.messages.findLastIndex((m) => m.role === "user" && m.content?.includes("HOST TASK"))
            const done = b.messages.slice(from).filter((m) => m.role === "tool").length
            const step = steps[done]
            if (!step) return sse(res, completionChunks(["Done."], {}))
            if (done === 3)
              await Effect.runPromise(
                api.SetWorkshopGrant({ chatId: chatId as never, capability: "commands.unsandboxed", mode: "allow" })
              )
            sse(res, call(step[0], step[1], `host_${done}`))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
        model: { context: 200000 }
      })
      assert.strictEqual((yield* api.Whoami()).role, "admin")
      const chat = yield* api.CreateWorkshop({ title: "Host" })
      chatId = chat.id

      // The server's folders, and the choice.
      const listed = yield* api.ListHostFolders({ path: null })
      assert.deepStrictEqual(listed.folders, [{ name: hostRoot, path: hostRoot }])
      const cast = yield* api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "WorkshopFolder", path: project, host: true }
      })
      assert.strictEqual(cast.workshopFolder?.path, project)
      assert.strictEqual(cast.workshopFolder?.host, true)
      const choices = yield* api.WorkshopFolderChoices({ chatId: chat.id, stored: cast.workshopFolder!, cardId: null })
      assert.strictEqual(choices.current, project)
      assert.isTrue(choices.hostFolders)
      // Not one of the allowed folders: refused.
      const outside = yield* api
        .ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "WorkshopFolder", path: "/usr", host: true } })
        .pipe(Effect.flip)
      assert.strictEqual(outside._tag, "NotFound")
      // Commands without a sandbox: offered to this admin, Off, with its consent.
      const offered = (yield* api.ListWorkshopCapabilities({ chatId: chat.id })).find(
        (c) => c.id === "commands.unsandboxed"
      )
      assert.strictEqual(offered?.mode, "off")
      assert.strictEqual(offered?.confirm?.confirmLabel, "Run without a sandbox")

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
          content: "HOST TASK: work in the project."
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
      assert.include(results[0], "A synthetic project.")
      assert.include(results[1], `${project}/notes.txt`)
      assert.strictEqual(yield* Effect.promise(() => readFile(join(project, "notes.txt"), "utf8")), "first\n")
      // Sandboxed: starts in the folder, changes it, can't see the app's data.
      assert.include(results[2], `Directory after: ${project}`)
      assert.include(results[2], `created ${project}/made.txt`)
      assert.include(results[2], "no-data")
      assert.isTrue(existsSync(join(project, "made.txt")))
      // Without the sandbox: it sees the server.
      assert.include(results[3], "sees-data")
      assert.include(results[3], "No sandbox: this ran directly on the server.")
      const effects = yield* api.ListVersionEffects({ versionId: id })
      const shells = effects.filter((e) => e.kind === "shell.run")
      assert.deepStrictEqual(shells.map((e) => e.targetKind).sort(), ["command", "command.unsandboxed"])
      // The write in the folder on the server is undone like one in Files.
      const created = effects.find((e) => e.kind === "file.create")!
      yield* api.UndoRolloutEffect({ rolloutId: created.rolloutId, toolCallId: created.toolCallId, seq: created.seq })
      assert.isFalse(existsSync(join(project, "notes.txt")))

      // Another account: neither is offered, and the folder can't be chosen.
      const me = yield* api.Whoami()
      yield* api.SetPassword({ userId: me.id, currentPassword: null, newPassword: "admin-password" })
      const admin = yield* client({ cookie: (yield* login(me.handle, "admin-password")).cookie })
      yield* admin.CreateUser({ handle: "bob", displayName: "Bob", role: "user", password: "bob-password" })
      const bob = yield* client({ cookie: (yield* login("bob", "bob-password")).cookie })
      const bobChat = yield* bob.CreateWorkshop({ title: "Bob's" })
      const bobChoices = yield* bob.WorkshopFolderChoices({ chatId: bobChat.id, stored: null, cardId: null })
      assert.isFalse(bobChoices.hostFolders)
      assert.isUndefined(
        (yield* bob.ListWorkshopCapabilities({ chatId: bobChat.id })).find((c) => c.id === "commands.unsandboxed")
      )
      const bobRefused = yield* bob
        .ChangeCast({ chatId: bobChat.id, slotId: null, change: { _tag: "WorkshopFolder", path: project, host: true } })
        .pipe(Effect.flip)
      assert.strictEqual(bobRefused._tag, "NotFound")
      assert.strictEqual((yield* bob.ListHostFolders({ path: null }).pipe(Effect.flip))._tag, "Forbidden")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  },
  180_000
)

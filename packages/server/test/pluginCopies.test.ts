// Process-spawn and real worker integration; synthetic source and loopback scripted transport only.
import { expect, it } from "vitest"
import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { pluginFolder } from "../src/plugins/repo.ts"
import { frozenTool, type ToolContext } from "../src/agent/tools.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { foldState } from "@rp/shared/state.ts"
import { generateReply, eventually, finished } from "./support/generation.ts"
import { startMockProvider, sse, completionChunks } from "./support/mockProvider.ts"

const chunks = (name: string, args: unknown) => [
  {
    id: "copy-call",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            { index: 0, id: "copy-call", type: "function", function: { name, arguments: JSON.stringify(args) } }
          ]
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "copy-call",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]

it("copies, changes and runs set_presence, refuses a second replacement, then restores identical request bytes", async () => {
  const config = testConfig()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* client(),
          execution = yield* ExecutionRegistry,
          reader = yield* Reader,
          me = yield* api.Whoami()
        const original = execution.rolloutTools.get("set_presence")!,
          bytes = JSON.stringify(frozenTool(original))
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((request, res) => {
              const done = ((request.body?.messages ?? []) as Array<{ role: string }>).filter(
                (m) => m.role === "tool"
              ).length
              sse(
                res,
                done === 0
                  ? chunks("set_presence", { character: "Mira", present: false })
                  : chunks("send_message", { message: "Mira leaves." })
              )
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          state: [{ key: "agent.enabled", value: { on: true } }]
        })
        const originalRequest = mock.requests()[0]!.raw
        const made = yield* api.CopyBuiltin({ registry: "rolloutTools", id: "set_presence", pluginId: "presence-copy" })
        expect(made.report, JSON.stringify(made.report)).toMatchObject({ ok: true })
        expect((yield* api.GetPlugin(made)).pin).toBeNull()
        expect((yield* api.GetPlugin(made)).manifest?.base?.app).toBe(made.report.appStamp)
        expect(execution.rolloutTools.get("set_presence")).toBe(original)
        const path = "src/part/presencePart.ts"
        const source = yield* Effect.promise(() =>
          readFile(join(pluginFolder(config.dataDir, "", made.id), path), "utf8")
        )
        const commit = yield* api.CommitPlugin({
          ...made,
          files: { [path]: source.replace("`${name} is ${present ?", "`Copied: ${name} is ${present ?") },
          message: "Explain the copied presence change"
        })
        expect(yield* api.EnablePlugin({ ...made, commit, consent: true })).toMatchObject({ ok: true })
        const other = yield* api.CopyBuiltin({
          registry: "rolloutTools",
          id: "set_presence",
          pluginId: "presence-other"
        })
        expect(yield* api.EnablePlugin({ ...other, consent: true })).toMatchObject({
          ok: false,
          message: "Another enabled plugin already replaces this part. Turn it off first."
        })
        const reply = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          state: [{ key: "agent.enabled", value: { on: true } }]
        })
        const steps = yield* api.GetRolloutSteps({ versionId: reply.version.id })
        expect(steps[0]).toMatchObject({
          kind: "tool",
          tool: "set_presence",
          label: "Changed who's present · Who's present (editable) (plugin)",
          effect: "chat_state",
          result: "Copied: Mira is away from the next message on."
        })
        expect(
          foldState(yield* reader.StateEventsAt({ userId: me.id, chatId: reply.chat.id, slotId: reply.version.slotId }))
            .away
        ).toContain(reply.mira.entityId)
        // The copied effect follows the displayed swipe, independently on each branch.
        const sourceFork = reply.chat.currentForkId!
        const { fork: peer } = yield* api.CreateFork({
          chatId: reply.chat.id,
          fromForkId: sourceFork,
          atSlotId: reply.version.slotId
        })
        mock.setHandler((_request, res) => sse(res, chunks("send_message", { message: "No presence change." })))
        const { entry } = yield* reader.GetSlot({ userId: me.id, slotId: reply.version.slotId, forkId: sourceFork })
        const swipe = yield* api.Regenerate({
          slotId: entry.slotId,
          expectedRowVersion: entry.rowVersion,
          forkId: sourceFork
        })
        yield* eventually(() => finished(reply.events, swipe.version.id) !== undefined)
        const away = (forkId: typeof sourceFork) =>
          reader
            .StateEventsAt({ userId: me.id, chatId: reply.chat.id, slotId: reply.version.slotId, forkId })
            .pipe(Effect.map((events) => foldState(events).away))
        expect(yield* away(sourceFork)).toEqual([])
        expect(yield* away(peer.id)).toEqual([reply.mira.entityId])
        yield* api.SelectVersion({
          slotId: reply.version.slotId,
          versionId: reply.version.id,
          expectedVersionId: swipe.version.id,
          forkId: sourceFork
        })
        expect(yield* away(sourceFork)).toEqual([reply.mira.entityId])
        yield* api.DisablePlugin(made)
        expect(execution.rolloutTools.get("set_presence")).toBe(original)
        expect(JSON.stringify(frozenTool(execution.rolloutTools.get("set_presence")!))).toBe(bytes)
        mock.setHandler((request, res) =>
          sse(
            res,
            ((request.body?.messages ?? []) as Array<{ role: string }>).some((m) => m.role === "tool")
              ? chunks("send_message", { message: "Mira leaves." })
              : chunks("set_presence", { character: "Mira", present: false })
          )
        )
        const nextRequest = mock.requests().length
        yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          state: [{ key: "agent.enabled", value: { on: true } }]
        })
        expect(mock.requests()[nextRequest]!.raw).toBe(originalRequest)
        expect(yield* api.EnablePlugin({ ...other, consent: true })).toMatchObject({ ok: true })
        yield* api.DisablePlugin(other)
        // A callback failure schedules durable suspension and reveals the exact original.
        const bad = yield* api.CommitPlugin({
          ...made,
          files: {
            [path]: source.replace(
              "const cards = yield* context.cast",
              'if (character === "throw") throw new Error("synthetic failure"); const cards = yield* context.cast'
            )
          },
          message: "Synthetic call failure"
        })
        expect(yield* api.EnablePlugin({ ...made, commit: bad, consent: true })).toMatchObject({ ok: true })
        yield* execution.rolloutTools
          .get("set_presence")!
          .execute({} as ToolContext, { character: "throw", present: false } as never)
          .pipe(Effect.exit)
        yield* eventually(() => execution.rolloutTools.get("set_presence") === original)
        expect((yield* api.GetPlugin(made)).pin?.suspended).toBeDefined()
      }).pipe(Effect.provide(serverLayer(config)))
    )
  )
}, 180000)

it("assistant copies are confined, inert, journalled and require the existing exact-call enable consent", async () => {
  const config = testConfig()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* client(),
          user = yield* api.Whoami(),
          execution = yield* ExecutionRegistry,
          reader = yield* Reader,
          writer = yield* Writer
        const chat = yield* api.CreateWorkshop({}),
          rolloutId = `copy-${chat.id}`
        yield* fixtureSql(config.dataDir, [
          {
            sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES (?,?,'workshop','running','assistant','interactive',1,1)",
            params: [rolloutId, chat.id]
          }
        ])
        const ctx: ToolContext = {
          userId: user.id,
          chatId: chat.id,
          forkId: chat.currentForkId,
          slotId: "unused" as never,
          versionId: "unused" as never,
          rolloutId,
          toolCallId: "copy",
          leafSlotId: null,
          reader,
          writer,
          viewers: null,
          cache: new Map()
        }
        const tool = execution.rolloutTools.get("plugin_copy_builtin")!
        expect(tool.effect).toBe("library")
        const listed = yield* tool.execute(ctx, {} as never)
        expect(listed.text).toContain('"copyable":true')
        const args = { registry: "noticeChannels", id: "notifications.completion-sound", pluginId: "assistant-copy" }
        const result = yield* tool.execute(ctx, args as never)
        expect(result.isError, result.text).not.toBe(true)
        const again = yield* tool.execute(ctx, args as never)
        expect(again.text).toBe(result.text)
        expect((yield* api.GetPlugin({ scope: "user", id: args.pluginId })).pin).toBeNull()
        const detail = yield* api.GetPlugin({ scope: "user", id: args.pluginId })
        expect(
          (yield* execution.rolloutTools
            .get("plugin_enable")!
            .execute({ ...ctx, toolCallId: "unapproved" }, { plugin: args.pluginId, commit: detail.commit } as never))
            .isError
        ).toBe(true)
        expect(
          (yield* tool.execute({ ...ctx, toolCallId: "escape" }, { ...args, id: "../../other" } as never)).isError
        ).toBe(true)
        expect(
          (yield* tool.execute({ ...ctx, rolloutId: "another-owner-run", toolCallId: "wrong-run" }, args as never))
            .isError
        ).toBe(true)
        const effects = yield* api.ListRolloutEffects({ chatId: chat.id })
        expect(effects.filter((e) => e.kind === "plugin.create")).toHaveLength(1)
        yield* api.UndoRolloutEffect(effects.find((e) => e.kind === "plugin.create")!)
        const retained = yield* api.GetPlugin({ scope: "user", id: args.pluginId })
        expect(retained.commit).toBe(detail.commit)
        expect(retained.pin === null || !!retained.pin.suspended).toBe(true)
      }).pipe(Effect.provide(serverLayer(config)))
    )
  )
}, 120000)

it("the data-only reverse macro copy checks, replaces worker assembly and restores on disable", async () => {
  const config = testConfig()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* client()
        const made = yield* api.CopyBuiltin({ registry: "macros", id: "reverse", pluginId: "reverse-copy" })
        expect(made.report, JSON.stringify(made.report)).toMatchObject({ ok: true })
        const path = "src/part/reverse.ts"
        const source = yield* Effect.promise(() =>
          readFile(join(pluginFolder(config.dataDir, "", made.id), path), "utf8")
        )
        const edited = yield* api.CommitPlugin({
          ...made,
          files: { [path]: source.replace("Array.from(call.args[0]!)", '"Edited " + Array.from(call.args[0]!)') },
          message: "Explain the reversed text"
        })
        expect(yield* api.EnablePlugin({ ...made, commit: edited, consent: true })).toMatchObject({ ok: true })
        const requests: Array<string> = []
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((request, res) => {
              requests.push(JSON.stringify(request.body))
              sse(res, completionChunks(["Synthetic reply."], {}))
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const generate = () =>
          generateReply(api, {
            connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
            model: {},
            greeting: "Macro:{{reverse::abc}}"
          })
        const replaced = yield* generate()
        expect((yield* api.GetRunContext({ versionId: replaced.version.id })).issues).toContainEqual({
          kind: "plugin_replacement",
          message: "{{reverse}} replaced by Reverse text macro (editable) (plugin)."
        })
        expect(requests.at(-1)).toContain("Macro:Edited cba")
        expect((yield* api.GetPlugin(made)).original).toMatchObject({ changed: false, available: true })
        yield* api.DisablePlugin(made)
        yield* generate()
        expect(requests.at(-1)).toContain("Macro:cba")
        expect(requests.at(-1)).not.toContain("Edited cba")
        const bad = yield* api.CommitPlugin({
          ...made,
          files: {
            [path]: source.replace(
              'Array.from(call.args[0]!).reverse().join("")',
              '(() => {throw new Error("synthetic macro failure")})()'
            )
          },
          message: "Synthetic macro failure"
        })
        expect(yield* api.EnablePlugin({ ...made, commit: bad, consent: true })).toMatchObject({ ok: true })
        yield* generate().pipe(Effect.exit)
        const detail = yield* api.GetPlugin(made)
        expect(detail.pin?.suspended).toBeDefined()
        yield* generate()
        expect(requests.at(-1)).toContain("Macro:cba")
      }).pipe(Effect.provide(serverLayer(config)))
    )
  )
}, 90000)

it("startup keeps the earliest replacement and visibly suspends a later conflicting pin", async () => {
  const config = testConfig()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* client(),
          user = yield* api.Whoami(),
          writer = yield* Writer,
          reader = yield* Reader
        const a = yield* api.CopyBuiltin({
          registry: "noticeChannels",
          id: "notifications.completion-sound",
          pluginId: "early-copy"
        })
        const b = yield* api.CopyBuiltin({
          registry: "noticeChannels",
          id: "notifications.completion-sound",
          pluginId: "late-copy"
        })
        expect(yield* api.EnablePlugin({ ...a, consent: true })).toMatchObject({ ok: true })
        const pins = yield* reader.GetPluginPins({ userId: user.id, owner: user.id })
        // A retained pre-P5/operator settings state can contain competing declarations.
        yield* writer.SetPluginPins({
          userId: user.id,
          owner: user.id,
          revision: pins.revision,
          value: {
            ...pins.value,
            [a.id]: { ...pins.value[a.id]!, enabledAt: 1 },
            [b.id]: { commit: b.commit, enabledAt: 2, enabledBy: user.id }
          }
        })
      }).pipe(Effect.provide(serverLayer(config)))
    )
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* client()
        const clients = yield* api.ListClientPlugins()
        expect(clients.map((p) => p.id)).toEqual(["early-copy"])
        expect((yield* api.GetPlugin({ scope: "user", id: "late-copy" })).pin?.suspended?.reason).toBe(
          "Another enabled plugin already replaces this part. Turn it off first."
        )
        yield* api.DisablePlugin({ scope: "user", id: "early-copy" })
        expect(yield* api.ListClientPlugins()).toEqual([])
      }).pipe(Effect.provide(serverLayer(config)))
    )
  )
}, 150000)

for (const [id, entry, args] of [
  ["search_chat", "searchChat", { query: "Synthetic" }],
  ["read_messages", "readMessages", { from: 1 }],
  ["expand_summary", "expandSummary", { messages: "1–1" }],
  ["search_summaries", "searchSummaries", { query: "Synthetic" }],
  ["list_notes", "listNotes", {}],
  ["switch_note", "switchNote", { note: "Synthetic", on: false }]
] as const)
  it(`copies, edits and runs ${id}, then restores exact request bytes`, async () => {
    const config = testConfig()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const api = yield* client(),
            execution = yield* ExecutionRegistry
          const original = execution.rolloutTools.get(id)!
          const mock = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startMockProvider((request, res) => {
                const done = ((request.body?.messages ?? []) as Array<{ role: string }>).some((m) => m.role === "tool")
                sse(res, done ? chunks("send_message", { message: "Synthetic reply." }) : chunks(id, args))
              })
            ),
            (m) => Effect.promise(() => m.close())
          )
          const generate = () =>
            generateReply(api, {
              connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
              model: {},
              greeting: "Synthetic earlier text",
              state: [
                { key: "agent.enabled", value: { on: true } },
                { key: "agent.tools", value: { tools: [id] } }
              ]
            })
          yield* generate()
          const before = mock.requests()[0]!.raw
          const made = yield* api.CopyBuiltin({
            registry: "rolloutTools",
            id,
            pluginId: `${id.replaceAll("_", "-")}-copy`
          })
          expect(made.report, JSON.stringify(made.report)).toMatchObject({ ok: true })
          const source = `import {Effect,type Activate} from "@rp/plugin-api/server"
import {${entry}} from "./part/${id.endsWith("notes") || id === "switch_note" ? "notesPart" : "historyPart"}.ts"
const replacement:typeof ${entry}={...${entry},execute:(context,args)=>Effect.map(${entry}.execute(context,args),out=>({...out,text:"Copied: "+out.text}))}
export const activate:Activate=host=>host.registries.rolloutTools!.register(replacement)`
          const commit = yield* api.CommitPlugin({
            ...made,
            files: { "src/server.ts": source },
            message: "Explain copied output"
          })
          expect(yield* api.EnablePlugin({ ...made, commit, consent: true })).toMatchObject({ ok: true })
          const other = yield* api.CopyBuiltin({
            registry: "rolloutTools",
            id,
            pluginId: `${id.replaceAll("_", "-")}-other`
          })
          expect(yield* api.EnablePlugin({ ...other, consent: true })).toMatchObject({
            ok: false,
            message: "Another enabled plugin already replaces this part. Turn it off first."
          })
          yield* generate()
          expect(JSON.stringify(mock.requests().at(-1)!.body)).toContain("Copied: ")
          expect(frozenTool(execution.rolloutTools.get(id)!).label).toContain("(plugin)")
          yield* api.DisablePlugin(made)
          expect(execution.rolloutTools.get(id)).toBe(original)
          const at = mock.requests().length
          yield* generate()
          expect(mock.requests()[at]!.raw).toBe(before)
        }).pipe(Effect.provide(serverLayer(config)))
      )
    )
  }, 180000)

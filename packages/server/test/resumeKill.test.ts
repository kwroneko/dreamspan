// A crash mid-rollout (spec/AGENTIC.md §12; owner, 2026-11-12): the server is killed with
// SIGKILL while an agent reply streams its final text, and while a request after a tool call
// waits for its answer. After a restart the reply reads interrupted, nothing is sent until the
// user resumes, and Resume carries the run on without a new user message. Slow: it spawns the
// server (vitest.config.ts SLOW_SERVER_FILES).
import { assert, it } from "@effect/vitest"
import type { ChatId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { Effect, Stream } from "effect"
import { spawn } from "node:child_process"
import type { ServerResponse } from "node:http"
import { Reader } from "../src/db/Database.ts"
import { client, clientAt, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

type Body = { readonly messages: Array<{ role: string; content?: unknown }>; readonly tools?: Array<unknown> }
const agentOn = [{ key: "agent.enabled" as const, value: { on: true } }]

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "cmpl-k",
  object: "chat.completion.chunk",
  model: "served-model",
  choices: [{ index: 0, delta, finish_reason: finish }]
})
const searchCall = [
  chunk({
    role: "assistant",
    tool_calls: [
      { index: 0, id: "c1", type: "function", function: { name: "search_chat", arguments: '{"query":"bridge"}' } }
    ]
  }),
  chunk({}, "tool_calls"),
  { id: "cmpl-k", object: "chat.completion.chunk", model: "served-model", choices: [], usage: { prompt_tokens: 9 } }
]
/** The user's side of the request (the app adds its own instruction after the user's message). */
const lastUser = (body: Body) => JSON.stringify(body.messages.filter((m) => m.role === "user").slice(-3))
const hasResult = (body: Body) => body.messages.some((m) => m.role === "tool")
const bodies = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body as unknown as Body)

/**
 * The scripted provider: the seeding reply is plain text; "Cut the text." gets a search, then
 * a final turn that streams "Ansel wa" and hangs; "Cut the wait." gets a search, then a request
 * that never answers. Once resumed, each finishes.
 */
const provider = () => {
  const held = { text: 0, wait: 0, plain: 0, first: 0, reasoning: 0, json: 0, unicode: 0 }
  const handler = (request: Recorded, res: ServerResponse) => {
    const body = request.body as unknown as Body
    const user = lastUser(body)
    const tail = JSON.stringify(body.messages.at(-1)?.content ?? "")
    if (body.messages.at(-1)?.role === "assistant")
      return sse(
        res,
        completionChunks([tail.includes("Mira sets") ? " down." : tail.includes("🌊") ? " waves." : "ves."], {
          prompt_tokens: 20
        })
      )
    if (user.includes("Cut the plain.") && held.plain++ === 0) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify(completionChunks(["Mira sets"], {})[0])}\n\n`)
      return
    }
    if (!user.includes("Cut the")) return sse(res, completionChunks(["Mira nods."], { prompt_tokens: 9 }))
    if (user.includes("Cut the first.")) {
      if (held.first++ === 0) return
      return sse(res, completionChunks(["Ansel waves."], { prompt_tokens: 20 }))
    }
    if (!hasResult(body)) return sse(res, searchCall)
    if (user.includes("Cut the reasoning.") && held.reasoning++ === 0) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify(chunk({ role: "assistant", reasoning_content: "Consider the tide 🌊." }))}\n\n`)
      return
    }
    if (user.includes("Cut the json.") && held.json++ === 0) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(
        `data: ${JSON.stringify(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "incomplete", type: "function", function: { name: "write_note", arguments: '{"title":"Must never exist","content":"cut' } }] }))}\n\n`
      )
      return
    }
    if (user.includes("Cut the unicode.") && held.unicode++ === 0) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify(completionChunks(["Ansel 🌊"], {})[0])}\n\n`)
      const torn = Buffer.from(`data: ${JSON.stringify(completionChunks(["漣"], {})[0])}\n\n`)
      res.write(torn.subarray(0, torn.indexOf(Buffer.from("漣")) + 1))
      return
    }
    if (user.includes("Cut the text.") && held.text++ === 0) {
      // One delta, then nothing more: the app dies here. The saves after a stall keep it.
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify(completionChunks(["Ansel wa"], {})[0])}\n\n`)
      return
    }
    if (user.includes("Cut the wait.") && held.wait++ === 0) return
    sse(res, completionChunks(["Ansel waves."], { prompt_tokens: 20, completion_tokens: 2 }))
  }
  return { held, handler }
}

/** The server as its own process on the test's data, killed with SIGKILL by `kill`. */
const spawnServer = (config: ReturnType<typeof testConfig>) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      let output = ""
      const child = spawn(process.execPath, ["--no-wasm-code-gc", "packages/server/src/main.ts"], {
        cwd: new URL("../../../", import.meta.url),
        env: {
          ...process.env,
          FAKE_CARD_SOURCE: "off",
          HOST: "127.0.0.1",
          PORT: "0",
          DATA_DIR: config.dataDir,
          DB_READERS: "1",
          DB_WORKERS: "source",
          AUTH_MODE: "single",
          CLIENT_DIST: config.clientDist
        },
        stdio: ["ignore", "pipe", "pipe"]
      })
      for (const stream of [child.stdout, child.stderr]) stream!.on("data", (b) => void (output += String(b)))
      yield* eventually(() => /Listening on http:\/\/127\.0\.0\.1:\d+/.test(output), 60_000)
      const port = Number(/Listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)![1])
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      const kill = () =>
        Effect.promise(async () => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
          await exited
        })
      return { port, kill, output: () => output }
    }),
    (server) => server.kill()
  )

const crashAndResume = (
  message:
    | "Cut the text."
    | "Cut the wait."
    | "Cut the plain."
    | "Cut the first."
    | "Cut the reasoning."
    | "Cut the json."
    | "Cut the unicode.",
  cutReached: (dataDir: string, held: ReturnType<typeof provider>["held"]) => Effect.Effect<boolean, unknown>
) => {
  const config = testConfig()
  // A plain reply (Tools off) goes on by Continue, the agent's by Resume.
  const plain = message === "Cut the plain."
  const kept = plain
    ? "Mira sets"
    : message === "Cut the text."
      ? "Ansel wa"
      : message === "Cut the unicode."
        ? "Ansel 🌊"
        : null
  const whole = plain ? "Mira sets down." : message === "Cut the unicode." ? "Ansel 🌊 waves." : "Ansel waves."
  return Effect.gen(function* () {
    const script = provider()
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider(script.handler)),
      (m) => Effect.promise(() => m.close())
    )
    // Seeded in this process: the chat, Tools on, a first reply. Then the process's server goes.
    const seeded = yield* Effect.scoped(
      Effect.gen(function* () {
        const api = yield* client()
        const { version, chat } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: { prefill: "assistant" },
          ...(plain ? {} : { state: agentOn })
        })
        assert.strictEqual(version.content, "Mira nods.")
        return { chatId: chat.id as ChatId, leaf: version.slotId as SlotId }
      }).pipe(Effect.provide(serverLayer(config)))
    )
    // The reply starts in a server of its own, which is killed at the cut.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* spawnServer(config)
        const api = yield* clientAt(server.port)
        const sent = yield* posted(
          api.SendMessage({ chatId: seeded.chatId, parentSlotId: seeded.leaf, branch: false, content: message })
        )
        yield* posted(api.Generate({ chatId: seeded.chatId, parentSlotId: sent.entry.slotId, branch: false }))
        const deadline = Date.now() + 30_000
        while (!(yield* cutReached(config.dataDir, script.held))) {
          if (Date.now() > deadline)
            return yield* Effect.die(
              new Error(
                `never reached the cut: ${JSON.stringify(script.held)} ${JSON.stringify(
                  bodies(mock.requests()).map((b) => [lastUser(b), b.messages.length, b.tools?.length ?? 0])
                )}\n${server.output()}`
              )
            )
          yield* Effect.sleep(50)
        }
        yield* server.kill()
      })
    )
    const before = bodies(mock.requests())
    // Restarted: the reply is interrupted, and nothing goes to the provider until Resume.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const api = yield* client()
        const me = yield* api.Whoami()
        const reader = yield* Reader
        const path = yield* reader.GetPath({ userId: me.id, chatId: seeded.chatId, leafSlotId: null, limit: 100 })
        const cut = path.entries.at(-1)!
        assert.strictEqual(cut.version.status, "interrupted")
        if (kept !== null) assert.strictEqual(cut.version.content, kept, "the text so far is kept")
        yield* Effect.sleep(1500)
        assert.lengthOf(bodies(mock.requests()), before.length, "a restart sends nothing by itself")
        const events: Array<ChatEvent> = []
        yield* api.SubscribeChat({ chatId: seeded.chatId }).pipe(
          Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
          Effect.forkScoped
        )
        yield* eventually(() => events.length > 0)
        const again = { versionId: cut.version.id, expectedRowVersion: cut.rowVersion }
        const entry = yield* plain ? api.ContinueVersion(again) : api.ResumeVersion(again)
        yield* eventually(() => finished(events, entry.version.id as VersionId) !== undefined)
        const resumed = finished(events, entry.version.id as VersionId)!
        assert.strictEqual(resumed.status, "complete", JSON.stringify(resumed.error))
        assert.strictEqual(resumed.content, whole)
        const after = bodies(mock.requests()).slice(before.length)
        assert.lengthOf(after, 1, "one request carries the run on")
        const cutRequest = before.at(-1)!
        if (kept !== null)
          assert.deepStrictEqual(
            after[0]!.messages,
            [...cutRequest.messages, { role: "assistant", content: kept }],
            "the request the text was cut in, then the text so far"
          )
        else assert.deepStrictEqual(after[0]!.messages, cutRequest.messages, "the unanswered request, sent again")
        assert.notInclude(JSON.stringify(after[0]!.messages), "Resume", "no new user message")
        assert.notInclude(JSON.stringify(after[0]!.messages), "Consider the tide", "cut thinking is resampled")
        assert.notInclude(
          JSON.stringify(after[0]!.messages),
          "Must never exist",
          "partial tool arguments are not executed or replayed"
        )
        const [notes] = yield* fixtureSql(
          config.dataDir,
          [{ sql: "SELECT count(*) AS n FROM entities WHERE kind = 'note'" }],
          { readOnly: true }
        )
        assert.strictEqual(notes![0]!.n, 0, "an incomplete tool call creates no note")
      }).pipe(Effect.provide(serverLayer(config)))
    )
  })
}

/** Whether the rollout transcript on disk holds `text`: the partial turn was saved. */
const savedText = (dataDir: string, text: string) =>
  Effect.map(
    fixtureSql(
      dataDir,
      [{ sql: "SELECT count(*) AS n FROM rollout_payloads WHERE transcript_json LIKE ?", params: [`%${text}%`] }],
      { readOnly: true }
    ),
    ([rows]) => ((rows![0] as { n: number }).n ?? 0) > 0
  )

it.live(
  "killed while the final text streams: interrupted after a restart, and Resume continues the text",
  () =>
    crashAndResume("Cut the text.", (dataDir) =>
      Effect.zipWith(
        savedText(dataDir, "Ansel wa"),
        Effect.map(
          fixtureSql(dataDir, [{ sql: "SELECT count(*) AS n FROM version_texts WHERE content = 'Ansel wa'" }], {
            readOnly: true
          }),
          ([rows]) => (rows![0] as { n: number }).n > 0
        ),
        (transcript, version) => transcript && version
      )
    ),
  { timeout: 180_000, tags: ["slow"] }
)

it.live(
  "killed while the request after a tool call waits: Resume sends that request again",
  () =>
    crashAndResume("Cut the wait.", (dataDir, held) =>
      held.wait > 0 ? savedText(dataDir, "toolResult") : Effect.succeed(false)
    ),
  { timeout: 180_000, tags: ["slow"] }
)

it.live(
  "a plain reply killed after one delta: its text is saved, and Continue carries it on",
  () =>
    crashAndResume("Cut the plain.", (dataDir) =>
      Effect.map(
        fixtureSql(dataDir, [{ sql: "SELECT count(*) AS n FROM version_texts WHERE content = 'Mira sets'" }], {
          readOnly: true
        }),
        ([rows]) => (rows![0] as { n: number }).n > 0
      )
    ),
  { timeout: 180_000, tags: ["slow"] }
)

it.live(
  "killed before the first byte: restart sends nothing and Resume resends the identical request",
  () => crashAndResume("Cut the first.", (_dir, held) => Effect.succeed(held.first > 0)),
  { timeout: 180_000, tags: ["slow"] }
)

it.live(
  "killed during reasoning: saved thinking is resampled without a new user message",
  () => crashAndResume("Cut the reasoning.", (dir) => savedText(dir, "Consider the tide")),
  { timeout: 180_000, tags: ["slow"] }
)

it.live(
  "killed inside tool-call JSON: no partial write is treated as a completed call",
  () =>
    crashAndResume("Cut the json.", (_dir, held) =>
      held.json > 0 ? Effect.as(Effect.sleep(2500), true) : Effect.succeed(false)
    ),
  { timeout: 180_000, tags: ["slow"] }
)

it.live(
  "killed inside a UTF-8 character and SSE frame: only complete text is kept",
  () => crashAndResume("Cut the unicode.", (dir) => savedText(dir, "Ansel 🌊")),
  { timeout: 180_000, tags: ["slow"] }
)

for (const phase of ["approval", "delegated reply"] as const)
  it.live(
    `workshop killed during ${phase}: receipts survive several messages and no send repeats`,
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        let target: ChatId
        let armed = false
        let targetHeld = 0
        const steps = () =>
          [
            ["create_card", { name: "Crash keeper", description: "A synthetic lighthouse keeper." }, "create"],
            ["send_message", { message: "The keeper is ready." }, "post"],
            ["rename_chat", { chat: target, name: "Renamed once" }, "rename"],
            ["generate_reply", { chat: target }, "generate"]
          ] as const
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((request, res) => {
              const body = request.body as unknown as Body
              if (!JSON.stringify(body.messages).includes("Crash workshop task")) {
                if (armed && phase === "delegated reply") {
                  targetHeld++
                  return
                }
                return sse(res, completionChunks(["Target wrote once."], {}))
              }
              const count = body.messages.filter((m) => m.role === "tool").length
              const step = steps()[count]
              if (!step) return sse(res, completionChunks(["Recovered."], {}))
              const [name, args, id] = step
              return sse(res, [
                chunk({
                  role: "assistant",
                  tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
                }),
                chunk({}, "tool_calls")
              ])
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const workshop = yield* Effect.scoped(
          Effect.gen(function* () {
            const api = yield* client()
            const seeded = yield* generateReply(api, {
              connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
              model: {},
              preset: { openai_max_context: 32768 }
            })
            target = seeded.chat.id
            const chat = yield* api.CreateWorkshop({})
            yield* api.SetWorkshopGrant({
              chatId: chat.id,
              capability: "library.write",
              mode: phase === "approval" ? "ask" : "allow"
            })
            yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "generate", mode: "allow" })
            return chat
          }).pipe(Effect.provide(serverLayer(config)))
        )
        armed = true
        yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawnServer(config)
            const api = yield* clientAt(child.port)
            const sent = yield* posted(
              api.SendMessage({
                chatId: workshop.id,
                parentSlotId: workshop.activeLeafSlotId,
                branch: false,
                content: "Crash workshop task"
              })
            )
            yield* posted(api.Generate({ chatId: workshop.id, parentSlotId: sent.entry.slotId, branch: false }))
            const deadline = Date.now() + 30_000
            while (true) {
              const [rows] = yield* fixtureSql(
                config.dataDir,
                [
                  {
                    sql:
                      phase === "approval"
                        ? "SELECT count(*) AS n FROM tool_approvals WHERE status = 'pending'"
                        : "SELECT count(*) AS n FROM rollout_receipts WHERE tool_call_id = 'generate'"
                  }
                ],
                { readOnly: true }
              )
              if (Number(rows![0]!.n) > 0 && (phase === "approval" || targetHeld > 0)) break
              if (Date.now() > deadline)
                return yield* Effect.die(new Error(`workshop never reached ${phase}: ${child.output()}`))
              yield* Effect.sleep(50)
            }
            yield* child.kill()
          })
        )
        const before = bodies(mock.requests()).length
        const heldBefore = targetHeld
        yield* Effect.scoped(
          Effect.gen(function* () {
            const api = yield* client()
            const me = yield* api.Whoami()
            const path = yield* (yield* Reader).GetPath({
              userId: me.id,
              chatId: workshop.id,
              leafSlotId: null,
              limit: 100
            })
            const cut = path.entries.at(-1)!
            assert.strictEqual(cut.version.status, "interrupted")
            if (phase === "delegated reply")
              assert.strictEqual(path.entries.at(-2)!.version.content, "The keeper is ready.")
            yield* Effect.sleep(1000)
            assert.lengthOf(bodies(mock.requests()), before, "restart never sends")
            const events: Array<ChatEvent> = []
            yield* api.SubscribeChat({ chatId: workshop.id }).pipe(
              Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
              Effect.forkScoped
            )
            yield* eventually(() => events.length > 0)
            const entry = yield* api.ResumeVersion({ versionId: cut.version.id, expectedRowVersion: cut.rowVersion })
            if (phase === "approval") {
              const prompt = () =>
                events
                  .flatMap((e) => (e._tag === "Steps" ? e.steps : []))
                  .findLast((s) => s.kind === "tool" && s.status === "waiting")
              yield* eventually(() => prompt() !== undefined)
              const step = prompt()!
              assert.isTrue(step.kind === "tool" && step.approval !== undefined)
              if (step.kind !== "tool" || !step.approval) return yield* Effect.die("no approval")
              assert.strictEqual(step.approval.uncertain, false, "waiting before the kill had not run")
              assert.lengthOf(bodies(mock.requests()), before, "Resume waits for fresh consent before a new request")
              assert.isEmpty((yield* api.ListLibrary({ kind: "card" })).filter((c) => c.label === "Crash keeper"))
              yield* api.AnswerToolApproval({
                rolloutId: step.approval.rolloutId,
                toolCallId: step.approval.toolCallId,
                digest: step.approval.digest,
                answer: "allow"
              })
            }
            yield* eventually(() =>
              events.some(
                (e) => e._tag === "Version" && e.version.content === "Recovered." && e.version.status === "complete"
              )
            )
            assert.lengthOf(
              (yield* api.ListLibrary({ kind: "card" })).filter((c) => c.label === "Crash keeper"),
              1
            )
            assert.strictEqual((yield* api.GetChat({ chatId: target })).title, "Renamed once")
            assert.strictEqual(targetHeld, heldBefore, "the delegated provider request is never sent twice")
            const effects = yield* api.ListRolloutEffects({ chatId: workshop.id })
            assert.lengthOf(effects, 3, "one library change, one setup change and one delegated generation")
            if (phase === "delegated reply") {
              const visible = yield* api.ListVersionEffects({ versionId: entry.version.id })
              assert.includeMembers(
                visible.map((effect) => effect.toolCallId),
                ["rename", "generate"],
                "the resumed reply retains Undo and regeneration warnings for committed calls"
              )
              const sent = bodies(mock.requests()).slice(before)
              assert.lengthOf(sent, 1)
              assert.include(
                JSON.stringify(sent[0]!.messages),
                "already committed",
                "the pending generation receipt explains the crash boundary"
              )
              assert.strictEqual(finished(events, entry.version.id)!.content, "Recovered.")
            }
          }).pipe(Effect.provide(serverLayer(config)))
        )
      })
    },
    { timeout: 180_000, tags: ["slow"] }
  )

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
  const held = { text: 0, wait: 0 }
  const handler = (request: Recorded, res: ServerResponse) => {
    const body = request.body as unknown as Body
    const user = lastUser(body)
    if (body.messages.at(-1)?.role === "assistant")
      return sse(res, completionChunks(["ves."], { prompt_tokens: 20, completion_tokens: 2 }))
    if (!user.includes("Cut the")) return sse(res, completionChunks(["Mira nods."], { prompt_tokens: 9 }))
    if (!hasResult(body)) return sse(res, searchCall)
    if (user.includes("Cut the text.") && held.text++ === 0) {
      // Text for a little over the 2 s between saves, then nothing more: the app dies here.
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify(completionChunks(["Ansel"], {})[0])}\n\n`)
      setTimeout(() => res.write(`data: ${JSON.stringify(completionChunks([" wa"], {})[0])}\n\n`), 2200)
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
  message: "Cut the text." | "Cut the wait.",
  cutReached: (dataDir: string, held: { text: number; wait: number }) => Effect.Effect<boolean, unknown>
) => {
  const config = testConfig()
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
          state: agentOn
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
        if (message === "Cut the text.") assert.strictEqual(cut.version.content, "Ansel wa", "the text so far is kept")
        yield* Effect.sleep(1500)
        assert.lengthOf(bodies(mock.requests()), before.length, "a restart sends nothing by itself")
        const events: Array<ChatEvent> = []
        yield* api.SubscribeChat({ chatId: seeded.chatId }).pipe(
          Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
          Effect.forkScoped
        )
        yield* eventually(() => events.length > 0)
        const entry = yield* api.ResumeVersion({ versionId: cut.version.id, expectedRowVersion: cut.rowVersion })
        yield* eventually(() => finished(events, entry.version.id as VersionId) !== undefined)
        const resumed = finished(events, entry.version.id as VersionId)!
        assert.strictEqual(resumed.status, "complete", JSON.stringify(resumed.error))
        assert.strictEqual(resumed.content, "Ansel waves.")
        const after = bodies(mock.requests()).slice(before.length)
        assert.lengthOf(after, 1, "one request carries the run on")
        const cutRequest = before.at(-1)!
        if (message === "Cut the text.")
          assert.deepStrictEqual(
            after[0]!.messages,
            [...cutRequest.messages, { role: "assistant", content: "Ansel wa" }],
            "the request the text was cut in, then the text so far"
          )
        else assert.deepStrictEqual(after[0]!.messages, cutRequest.messages, "the unanswered request, sent again")
        assert.notInclude(JSON.stringify(after[0]!.messages), "Resume", "no new user message")
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

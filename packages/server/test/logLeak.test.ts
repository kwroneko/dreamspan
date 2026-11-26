import { spawn } from "node:child_process"
import { Cause, Effect, Logger, Schema, Stream } from "effect"
import { expect, it } from "vitest"
import { ImportResult } from "@dreamspan/shared/libraryImport.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { serverLogs } from "../src/serverLogs.ts"
import { clientAt, posted } from "./support/config.ts"
import { eventually, finished } from "./support/generation.ts"
import { json, startMockProvider } from "./support/mockProvider.ts"
import { tempDir } from "./support/tempDir.ts"

const secret = "sk-synthetic-log-audit-21698"
const story = "Six violet compasses slept beneath the observatory."

it("keeps keys, story text and provider error bodies out of server output", async () => {
  const provider = await startMockProvider((request, response) => {
    if (request.path === "/v1/chat/completions") {
      json(response, 400, { error: { message: `${request.headers.authorization} ${request.raw}` } })
    } else {
      json(response, 404, {})
    }
  })
  const child = spawn(process.execPath, ["--no-wasm-code-gc", "src/main.ts"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      DATA_DIR: tempDir("log-leak"),
      HOST: "127.0.0.1",
      PORT: "0",
      AUTH_MODE: "single",
      DB_READERS: "1",
      DB_WORKERS: "source",
      FAKE_CARD_SOURCE: "off"
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let logs = ""
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => (logs += chunk))
  }
  // 'close' waits for both output streams, including the workers' forwarded logs.
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  try {
    await Effect.runPromise(
      eventually(() => child.exitCode !== null || /Listening on http:\/\/127\.0\.0\.1:\d+/.test(logs), 45_000)
    )
    const port = Number(/Listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(logs)?.[1])
    expect(port, "the synthetic server bound a port").toBeGreaterThan(0)
    const base = `http://127.0.0.1:${port}`
    const response = await fetch(`${base}/library/import?name=observatory.json`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: JSON.stringify({ name: "Cartographer", description: story, first_mes: "The dome is open." })
    })
    expect(response.status).toBe(200)
    const imported = Schema.decodeUnknownSync(ImportResult)(await response.json())
    expect(imported.library?.ref.label).toBe("Cartographer")

    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* clientAt(port)
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          apiKey: secret,
          settings: {
            name: "Synthetic provider",
            baseUrl: `${provider.url}/v1`,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        const model = yield* api.AddUserModel({ connectionId: connection.id, key: "synthetic-model", overrides: {} })
        yield* api.ChangeGenerationDefaults({ change: { model: { connection: connection.id, model: model.id } } })
        const card = (yield* api.ListCards()).find((card) => card.name === "Cartographer")!
        const { chat } = yield* api.StartChat({
          cards: [card.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: story, speakerEntityId: null }
        })
        const events: ChatEvent[] = []
        yield* api.SubscribeChat({ chatId: chat.id }).pipe(
          Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
          Effect.forkScoped
        )
        yield* eventually(() => events.length > 0)
        const { entry } = yield* posted(
          api.Generate({ chatId: chat.id, parentSlotId: chat.activeLeafSlotId, branch: false })
        )
        yield* eventually(() => finished(events, entry.version.id) !== undefined)
        expect(finished(events, entry.version.id)?.status).toBe("failed")
      }).pipe(Effect.scoped)
    )
    const request = provider.requests().find((request) => request.path === "/v1/chat/completions")
    expect(request?.headers.authorization).toBe(`Bearer ${secret}`)
    expect(request?.raw).toContain(story)
    // File names and arbitrary URL paths are also private, even on a failed request.
    const unmatched = await fetch(`${base}/private/${secret}/${encodeURIComponent(story)}`)
    await unmatched.arrayBuffer()
  } finally {
    child.kill("SIGTERM")
    await Promise.all([closed, provider.close()])
  }

  expect(logs).toContain("Sent HTTP response")
  for (const line of logs.split("\n")) {
    expect(line).not.toContain(secret)
    expect(line).not.toContain(story)
    expect(line).not.toContain(encodeURIComponent(story))
  }
}, 120_000)

it("formats failures and defects without rendering their values", () => {
  const lines: string[] = []
  const collector = Logger.make((entry) => lines.push(Logger.formatJson.log(entry)))
  Effect.runSync(
    Effect.gen(function* () {
      yield* Effect.logWarning("Provider request failed", new Error(secret))
      yield* Effect.logError("Reply processing crashed", Cause.die(new Error(story)))
    }).pipe(Effect.provide(serverLogs), Effect.provide(Logger.layer([collector])))
  )
  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain("Provider request failed")
  expect(lines[0]).not.toContain(secret)
  expect(lines[1]).toContain("Reply processing crashed")
  expect(lines[1]).not.toContain(story)
})

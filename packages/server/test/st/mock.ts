// A mock OpenAI-compatible endpoint on loopback for the ST harness. It records every request
// and answers each completion with the same fixed text, streamed or not, so ST finishes the
// turn as it would with a real model.
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"

export const MOCK_MODEL = "st-diff-model"
export const MOCK_REPLY = "The mock model replies."

interface Recorded {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

export interface MockEndpoint {
  /** The base URL ST's custom source takes, ending in `/v1`. */
  readonly url: string
  readonly requests: ReadonlyArray<Recorded>
  /** Resolves with the first completion request recorded from now on. */
  readonly nextCompletion: (timeoutMs?: number) => Promise<Recorded>
  readonly stop: () => Promise<void>
}

const readBody = async (request: IncomingMessage) => {
  const chunks: Array<Buffer> = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString("utf8")
  if (text === "") return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

const chunk = (delta: object, finish: string | null) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-st-diff",
    object: "chat.completion.chunk",
    created: 0,
    model: MOCK_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }]
  })}\n\n`

export const startMock = async (): Promise<MockEndpoint> => {
  const requests: Array<Recorded> = []
  const waiting: Array<(recorded: Recorded) => void> = []

  const server = createServer(async (request, response) => {
    const body = await readBody(request)
    const path = (request.url ?? "/").split("?")[0] ?? "/"
    const recorded = { method: request.method ?? "GET", path, body }
    requests.push(recorded)

    if (path === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ object: "list", data: [{ id: MOCK_MODEL, object: "model", owned_by: "mock" }] }))
      return
    }
    if (path !== "/v1/chat/completions" || request.method !== "POST") {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: `no route ${path}` } }))
      return
    }
    for (const resolve of waiting.splice(0)) resolve(recorded)
    const stream = typeof body === "object" && body !== null && (body as { stream?: unknown }).stream === true
    if (stream) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      response.write(chunk({ role: "assistant", content: MOCK_REPLY }, null))
      response.write(chunk({}, "stop"))
      response.end("data: [DONE]\n\n")
      return
    }
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        id: "chatcmpl-st-diff",
        object: "chat.completion",
        created: 0,
        model: MOCK_MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: MOCK_REPLY }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    nextCompletion: (timeoutMs = 60_000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no completion request within ${timeoutMs} ms`)), timeoutMs)
        waiting.push((recorded) => {
          clearTimeout(timer)
          resolve(recorded)
        })
      }),
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

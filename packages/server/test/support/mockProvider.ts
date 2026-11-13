// A scripted model provider for tests: records every request and answers with whatever
// the test scripts, in the real wire formats (SSE for streams).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo, Socket } from "node:net"

export interface Recorded {
  readonly method: string
  readonly path: string
  readonly headers: IncomingMessage["headers"]
  readonly body: Record<string, unknown> | null
  /** Actual HTTP body for cache-sensitive replay assertions. */
  readonly raw?: string
}

export type Handler = (request: Recorded, res: ServerResponse) => void | Promise<void>

export const sse = (res: ServerResponse, events: ReadonlyArray<unknown>, options: { done?: boolean } = {}) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
  if (options.done ?? true) res.write("data: [DONE]\n\n")
  res.end()
}

/** Anthropic's SSE has named events. */
export const anthropicSse = (
  res: ServerResponse,
  events: ReadonlyArray<{ type: string } & Record<string, unknown>>
) => {
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
}

export const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers })
  res.end(JSON.stringify(body))
}

/** OpenAI Chat Completions chunks that stream `text`, then report `usage`. */
export const completionChunks = (
  text: ReadonlyArray<string>,
  usage: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) => [
  ...text.map((content, i) => ({
    id: "cmpl-1",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content } : { content }, finish_reason: null }],
    ...extra
  })),
  {
    id: "cmpl-1",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    ...extra
  },
  { id: "cmpl-1", object: "chat.completion.chunk", model: "served-model", choices: [], usage, ...extra }
]

export const startMockProvider = (handler: Handler) =>
  new Promise<{
    readonly url: string
    readonly requests: () => ReadonlyArray<Recorded>
    readonly setHandler: (next: Handler) => void
    readonly close: () => Promise<void>
  }>((resolve) => {
    const requests: Array<Recorded> = []
    let current = handler
    const sockets = new Set<Socket>()
    const server = createServer((req, res) => {
      let raw = ""
      req.on("data", (chunk) => (raw += chunk))
      req.on("end", () => {
        let body: Record<string, unknown> | null = null
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
        } catch {
          body = null
        }
        const recorded = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body, raw }
        requests.push(recorded)
        void Promise.resolve(current(recorded, res)).catch(() => res.destroy())
      })
    })
    server.on("connection", (socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
    })
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests: () => requests,
        setHandler: (next) => (current = next),
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => done())
          })
      })
    })
  })

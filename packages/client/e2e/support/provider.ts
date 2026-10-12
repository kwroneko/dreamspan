// A fake OpenAI-compatible provider on loopback: it lists two models, answers chat
// completions with a short streamed reply, and records the keys and request bodies it was
// sent. No real provider or key is ever used.
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

export interface FakeProvider {
  readonly baseUrl: string
  /** The bearer tokens received, in order. */
  readonly keys: ReadonlyArray<string>
  /** The chat completion requests received, parsed, in order. */
  readonly completions: ReadonlyArray<{ readonly messages: ReadonlyArray<{ role: string; content: string }> }>
  readonly stop: () => Promise<void>
}

const chunk = (delta: Record<string, unknown>, finish: string | null) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", model: "fake-small", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

export const startProvider = async (): Promise<FakeProvider> => {
  const keys: Array<string> = []
  const completions: Array<FakeProvider["completions"][number]> = []
  const server = createServer((request, response) => {
    const auth = request.headers.authorization
    if (auth?.startsWith("Bearer ")) keys.push(auth.slice(7))
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          data: [
            { id: "fake-small", name: "Fake Small", context_length: 32768 },
            { id: "fake-large", name: "Fake Large", context_length: 131072, max_model_len: 131072 }
          ]
        })
      )
      return
    }
    if (request.url === "/v1/chat/completions" && request.method === "POST") {
      let body = ""
      request.on("data", (data: Buffer) => (body += data.toString()))
      request.on("end", () => {
        completions.push(JSON.parse(body) as FakeProvider["completions"][number])
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(chunk({ role: "assistant", content: "The bridge holds." }, null))
        response.write(chunk({}, "stop"))
        response.end("data: [DONE]\n\n")
      })
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    keys,
    completions,
    stop: () => new Promise((done) => server.close(() => done()))
  }
}

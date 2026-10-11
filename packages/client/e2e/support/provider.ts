// A fake OpenAI-compatible provider on loopback: it lists two models and records the keys
// it was sent. No real provider or key is ever used.
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

export interface FakeProvider {
  readonly baseUrl: string
  /** The bearer tokens received, in order. */
  readonly keys: ReadonlyArray<string>
  readonly stop: () => Promise<void>
}

export const startProvider = async (): Promise<FakeProvider> => {
  const keys: Array<string> = []
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
    response.writeHead(404).end()
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    keys,
    stop: () => new Promise((done) => server.close(() => done()))
  }
}

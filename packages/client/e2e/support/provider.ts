// A fake OpenAI-compatible provider on loopback: it lists two models, streams the same reply
// to every chat completion, reporting a cache read, and records the keys and request bodies it
// was sent. No real provider or key is ever used.
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, type Page } from "@playwright/test"

/** On the new connection form, picks the provider the fake one stands for: a custom server. */
export const chooseCustomServer = async (page: Page) => {
  const picker = page.getByRole("combobox", { name: "Provider", exact: true })
  await picker.click()
  // By its label: on a phone the option's explanation is part of its name.
  await page
    .getByRole("option")
    .filter({ has: page.getByText("OpenAI-compatible (custom)", { exact: true }) })
    .click()
  await expect(picker).toContainText("OpenAI-compatible")
}

export interface FakeProvider {
  readonly baseUrl: string
  readonly listings: number
  /** The model ids whose endpoint lists were asked for (`author/slug`), in order. */
  readonly endpointRequests: ReadonlyArray<string>
  /** The bearer tokens received, in order. */
  readonly keys: ReadonlyArray<string>
  /** The chat completion requests received, parsed, in order. */
  readonly completions: ReadonlyArray<{ readonly messages: ReadonlyArray<{ role: string; content: string }> }>
  /** Exact HTTP request bodies, before parsing. Synthetic requests only. */
  readonly completionBytes: ReadonlyArray<string>
  readonly hold: () => void
  readonly release: () => void
  readonly stop: () => Promise<void>
}

/** The reply every chat completion streams. */
export const REPLY = "The bridge holds."

const chunk = (body: Record<string, unknown>) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", model: "fake-small", ...body })}\n\n`

export const startProvider = async (
  options: {
    holdAfterText?: boolean
    /** Honour output ceilings in billing-bound tests. */
    respectOutputLimit?: boolean
    /** Streamed instead of REPLY. */ reply?: string
    /** The charge the usage reports, as OpenRouter's `usage.cost` does; none by default. */
    usageCost?: number
    models?: ReadonlyArray<{
      id: string
      name: string
      context_length: number
      pricing?: { prompt: string; completion: string }
    }>
    /** Served at `/models/{author}/{slug}/endpoints`, by `author/slug`; any other model's list is a 404. */
    endpoints?: Readonly<Record<string, unknown>>
  } = {}
): Promise<FakeProvider> => {
  const reply = options.reply ?? REPLY
  const keys: Array<string> = []
  let listings = 0
  const endpointRequests: Array<string> = []
  const completions: Array<FakeProvider["completions"][number]> = []
  const completionBytes: Array<string> = []
  let holding = false
  let holdingText = options.holdAfterText ?? false
  const held: Array<() => void> = []
  const respond = (response: ServerResponse, body?: Record<string, unknown>) => {
    const output = options.respectOutputLimit
      ? Math.min(6, Number(body?.["max_completion_tokens"] ?? body?.["max_tokens"] ?? 6))
      : 6
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] })
    )
    const finish = () => {
      if (response.destroyed) return
      response.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }))
      response.write(
        chunk({
          choices: [],
          usage: {
            prompt_tokens: 120,
            completion_tokens: output,
            prompt_tokens_details: { cached_tokens: 100 },
            ...(options.usageCost === undefined ? {} : { cost: options.usageCost })
          }
        })
      )
      response.end("data: [DONE]\n\n")
    }
    if (holdingText) held.push(finish)
    else finish()
  }
  const server = createServer((request, response) => {
    const auth = request.headers.authorization
    if (auth?.startsWith("Bearer ")) keys.push(auth.slice(7))
    if (request.url === "/v1/models") {
      listings++
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          data: options.models ?? [
            { id: "fake-small", name: "Fake Small", context_length: 32768 },
            { id: "fake-large", name: "Fake Large", context_length: 131072, max_model_len: 131072 }
          ]
        })
      )
      return
    }
    const endpointsOf = /^\/v1\/models\/([^/]+\/[^/]+)\/endpoints$/.exec(request.url ?? "")
    if (endpointsOf) {
      const id = decodeURIComponent(endpointsOf[1]!)
      endpointRequests.push(id)
      const body = options.endpoints?.[id]
      response.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" })
      response.end(JSON.stringify(body ?? { error: { message: "no endpoints" } }))
      return
    }
    if (request.url === "/v1/chat/completions" && request.method === "POST") {
      let body = ""
      request.on("data", (data: Buffer) => (body += data.toString()))
      request.on("end", () => {
        completionBytes.push(body)
        const parsed = JSON.parse(body) as Record<string, unknown>
        completions.push(parsed as unknown as FakeProvider["completions"][number])
        if (holding) held.push(() => respond(response, parsed))
        else respond(response, parsed)
      })
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get listings() {
      return listings
    },
    endpointRequests,
    keys,
    completions,
    completionBytes,
    hold: () => {
      holding = true
    },
    release: () => {
      holding = false
      holdingText = false
      for (const send of held.splice(0)) send()
    },
    stop: () =>
      new Promise((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

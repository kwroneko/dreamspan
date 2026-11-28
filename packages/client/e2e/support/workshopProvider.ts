// A scripted, tool-calling OpenAI-compatible provider on loopback for workshop browser tests: a
// request offering the library tools gets a script of calls and prose; a story request gets
// a plain reply. Scripts that call deferred tools directly use the Every tool connection setting.
// Synthetic text only; no real provider or key is ever used.
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export const WORKSHOP_ANSWER = "I read the Assistant and created the card Mara Quill in your library."
export const WORKSHOP_FIRST = "I’ll look through the library first."
export const WORKSHOP_SECOND = "The Assistant card is practical and brief. I’ll check the preset too."
export const STORY_REPLY = "The harbor bell rings twice."

const CALLS = [
  { name: "list_library", arguments: { kind: "card" } },
  { name: "read_card", arguments: { card: "Assistant", fields: ["description"] }, prose: WORKSHOP_FIRST },
  { name: "read_preset", arguments: { preset: "Workshop" }, prose: WORKSHOP_SECOND },
  { name: "create_card", arguments: { name: "Mara Quill", description: "A synthetic lighthouse keeper." } }
]

interface Body {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content?: unknown }>
  readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string } }>
}

interface Script {
  readonly name: string
  readonly prose?: string
  readonly arguments: object | ((body: Body) => object)
}

/**
 * `calls`: the tool calls a request offering the library tools gets, one a request, then the
 * answer. `perTask`: count them from the latest user message, so every task runs them again
 * (the request also holds prior turns); by default from the start of the request.
 */
export const startWorkshopProvider = async (
  options: {
    readonly calls?: ReadonlyArray<Script>
    readonly offeredTool?: string
    readonly perTask?: boolean
    readonly fail?: (body: Body, round: number) => boolean
    readonly answer?: string | ((body: Body) => string)
  } = {}
) => {
  const calls: ReadonlyArray<Script> = options.calls ?? CALLS
  const final = options.answer ?? WORKSHOP_ANSWER
  const bodies: Array<Body> = []
  let holding: number | null = null
  const held: Array<() => void> = []
  const chunk = (delta: object, finish: string | null = null, usage?: object) =>
    `data: ${JSON.stringify({
      id: "workshop",
      object: "chat.completion.chunk",
      model: "workshop-small",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {})
    })}\n\n`
  const stream = (res: ServerResponse, parts: ReadonlyArray<string>) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    let i = 0
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer)
      if (i < parts.length) res.write(parts[i++])
      else {
        clearInterval(timer)
        res.end("data: [DONE]\n\n")
      }
    }, 30)
    res.on("close", () => clearInterval(timer))
  }
  const words = (text: string) =>
    text.match(/\S+\s*/g)!.map((t, i) => chunk(i === 0 ? { role: "assistant", content: t } : { content: t }))
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ object: "list", data: [{ id: "workshop-small", object: "model" }] }))
    }
    if (req.url !== "/v1/chat/completions") return res.writeHead(404).end()
    let raw = ""
    req.on("data", (c: Buffer) => (raw += c.toString()))
    req.on("end", () => {
      const body = JSON.parse(raw) as Body
      bodies.push(body)
      const usage = { prompt_tokens: 300, completion_tokens: 10 }
      const library =
        body.tools?.some((tool) => tool.function.name === (options.offeredTool ?? "list_library")) === true
      if (!library) return stream(res, [...words(STORY_REPLY), chunk({}, "stop"), chunk({}, null, usage)])
      const from = options.perTask ? body.messages.findLastIndex((m) => m.role === "user") : 0
      const done = body.messages.slice(Math.max(0, from)).filter((m) => m.role === "tool").length
      if (options.fail?.(body, done)) return res.writeHead(500).end("Synthetic provider failure")
      const call = calls[done]
      const answer = () =>
        call
          ? stream(res, [
              ...(call.prose ? words(call.prose) : []),
              chunk({
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${done + 1}`,
                    type: "function",
                    function: {
                      name: call.name,
                      arguments: JSON.stringify(
                        typeof call.arguments === "function" ? call.arguments(body) : call.arguments
                      )
                    }
                  }
                ]
              }),
              chunk({}, "tool_calls"),
              chunk({}, null, usage)
            ])
          : stream(res, [
              ...words(typeof final === "function" ? final(body) : final),
              chunk({}, "stop"),
              chunk({}, null, usage)
            ])
      if (holding === done) held.push(answer)
      else answer()
    })
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    bodies,
    hold: (at: number) => {
      holding = at
    },
    heldCount: () => held.length,
    release: () => {
      holding = null
      for (const answer of held.splice(0)) answer()
    },
    /** The tool results the workshop's requests carried back, in order. */
    toolResults: () =>
      (bodies.at(-1)?.messages ?? []).filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content)),
    stop: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

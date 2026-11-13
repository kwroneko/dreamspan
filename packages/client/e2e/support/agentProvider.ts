// A scripted, tool-calling OpenAI-compatible provider on loopback, for agent replies' browser
// tests: a request offering tools gets a search_chat call, then a second one, then the reply.
// `hold()` keeps the final answer back until `release()`, so a test sees a run mid-way; `hold(1)`
// holds the request after the first call's result instead (a Stop there leaves a stopped run with
// one step), and `fail(1)` answers that request once with an error. Synthetic text only; no real
// provider or key is ever used.
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export const AGENT_REPLY = "Mira lifts the lantern and points across the flooded bridge."
export const PLAIN_REPLY = "The rain keeps falling."
export const THINKING = "The traveler asked about the bridge; check what was said of it."

const QUERIES = ["bridge", "lantern"]

export const startAgentProvider = async () => {
  /** The tool results a request has when it's held or failed: QUERIES.length is the final answer. */
  let holding: number | null = null
  let failing: number | null = null
  let failingPlain = false
  let holdingPlain = false
  const held: Array<() => void> = []
  const bodies: Array<{ messages: Array<{ role: string }>; tools?: unknown }> = []
  const chunk = (delta: object, finish: string | null = null, usage?: object) =>
    `data: ${JSON.stringify({
      id: "agent",
      object: "chat.completion.chunk",
      model: "agent-small",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {})
    })}\n\n`
  const stream = (res: ServerResponse, parts: Array<string>, delay = 40) => {
    // A held request the reply's Stop gave up on.
    if (res.destroyed) return
    res.writeHead(200, { "content-type": "text/event-stream" })
    let i = 0
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer)
      if (i < parts.length) res.write(parts[i++])
      else {
        clearInterval(timer)
        res.end("data: [DONE]\n\n")
      }
    }, delay)
    res.on("close", () => clearInterval(timer))
  }
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ object: "list", data: [{ id: "agent-small", object: "model" }] }))
    }
    if (req.url !== "/v1/chat/completions") return res.writeHead(404).end()
    let raw = ""
    req.on("data", (c: Buffer) => (raw += c.toString()))
    req.on("end", () => {
      const body = JSON.parse(raw) as (typeof bodies)[number]
      bodies.push(body)
      const usage = { prompt_tokens: 400, completion_tokens: 12 }
      if (!body.tools) {
        if (holdingPlain) {
          held.push(() =>
            stream(res, [chunk({ role: "assistant", content: PLAIN_REPLY }), chunk({}, "stop"), chunk({}, null, usage)])
          )
          return
        }
        if (failingPlain) {
          failingPlain = false
          res.writeHead(400, { "content-type": "application/json" })
          return res.end(JSON.stringify({ error: { message: "The synthetic provider refused this request." } }))
        }
        return stream(res, [
          chunk({ role: "assistant", content: PLAIN_REPLY }),
          chunk({}, "stop"),
          chunk({}, null, usage)
        ])
      }
      const done = body.messages.filter((m) => m.role === "tool").length
      if (failing === done) {
        failing = null
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: { message: "The synthetic provider refused this request." } }))
      }
      const answer =
        done < QUERIES.length
          ? () =>
              stream(res, [
                chunk({
                  role: "assistant",
                  ...(done === 0 ? { reasoning_content: THINKING } : {}),
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${done + 1}`,
                      type: "function",
                      function: { name: "search_chat", arguments: JSON.stringify({ query: QUERIES[done] }) }
                    }
                  ]
                }),
                chunk({}, "tool_calls"),
                chunk({}, null, usage)
              ])
          : () =>
              stream(res, [
                ...AGENT_REPLY.match(/\S+\s*/g)!.map((t, i) =>
                  chunk(i === 0 ? { role: "assistant", content: t } : { content: t })
                ),
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
    /** Holds requests with `at` tool results (by default the final answer) until `release()`. */
    hold: (at = QUERIES.length) => {
      holding = at
    },
    /** How many requests are being held. */
    heldCount: () => held.length,
    /** Answers the next request with `at` tool results with an error. */
    fail: (at: number) => {
      failing = at
    },
    /** Answers the next request without tools (a plain reply) with an error. */
    failPlain: () => {
      failingPlain = true
    },
    holdPlain: () => {
      holdingPlain = true
    },
    release: () => {
      holding = null
      holdingPlain = false
      for (const go of held.splice(0)) go()
    },
    stop: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

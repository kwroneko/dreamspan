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
/** What a held plain reply with `holdPlain(true)` has written when it's stopped. */
export const PARTIAL_REPLY = "The rain"
/** How `failPlain` fails: a 400, a stream the provider ends on content_filter, or a 403 with a long body. */
export type PlainFailure = "bad_request" | "content_filter" | "denied"
const FAIL_MESSAGE = "The synthetic provider refused this request."
/** A 403 whose body is long JSON, as some gateways send. */
const DENIED_BODY = {
  error: {
    message: "Access denied: this key may not use the requested model in this region.",
    type: "permission_error",
    code: "model_access_denied",
    param: null,
    details: {
      request_id: "req_0f3c9a1e7b2d4c5f8a6e9b1d3c7f2a4e",
      allowed_models: ["synthetic-small", "synthetic-medium", "synthetic-large-preview-2026-10-01"],
      policy: "org-default/model-allowlist/v3"
    }
  }
}
export const THINKING = "The traveler asked about the bridge; check what was said of it."

const QUERIES = ["bridge", "lantern"]

const offers = (body: { readonly tools?: unknown }, name: string) =>
  Array.isArray(body.tools) && body.tools.some((t: { function?: { name?: string } }) => t.function?.name === name)

export const startAgentProvider = async () => {
  /** The tool results a request has when it's held or failed: QUERIES.length is the final answer. */
  let holding: number | null = null
  let failing: number | null = null
  let failingPlain: PlainFailure | null = null
  let holdingPlain = false
  let partialPlain = false
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
      if (offers(body, "continue_reply")) {
        // Schema prefill asks for the whole reply, including the text sent before Stop.
        return stream(res, [
          chunk({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "continue_plain",
                type: "function",
                function: { name: "continue_reply", arguments: JSON.stringify({ text: PLAIN_REPLY }) }
              }
            ]
          }),
          chunk({}, "tool_calls"),
          chunk({}, null, usage)
        ])
      }
      if (!body.tools) {
        if (holdingPlain && partialPlain) {
          // Some text first, then nothing until the reply's Stop gives up on it.
          res.writeHead(200, { "content-type": "text/event-stream" })
          res.write(chunk({ role: "assistant", content: PARTIAL_REPLY }))
          held.push(() => {
            if (!res.destroyed) res.end("data: [DONE]\n\n")
          })
          return
        }
        if (holdingPlain) {
          held.push(() =>
            stream(res, [chunk({ role: "assistant", content: PLAIN_REPLY }), chunk({}, "stop"), chunk({}, null, usage)])
          )
          return
        }
        if (failingPlain) {
          const kind = failingPlain
          failingPlain = null
          if (kind === "content_filter")
            return stream(res, [chunk({ role: "assistant", content: "" }), chunk({}, "content_filter")])
          res.writeHead(kind === "denied" ? 403 : 400, { "content-type": "application/json" })
          return res.end(JSON.stringify(kind === "denied" ? DENIED_BODY : { error: { message: FAIL_MESSAGE } }))
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
          : offers(body, "send_message")
            ? // The reply through the send tool, where it's offered (spec/REPLY-CONTRACT.md §3.1).
              () =>
                stream(res, [
                  chunk({
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_${done + 1}`,
                        type: "function",
                        function: { name: "send_message", arguments: JSON.stringify({ message: AGENT_REPLY }) }
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
    failPlain: (kind: PlainFailure = "bad_request") => {
      failingPlain = kind
    },
    /** Holds the next plain replies; with `partial`, after sending PARTIAL_REPLY. */
    holdPlain: (partial = false) => {
      holdingPlain = true
      partialPlain = partial
    },
    release: () => {
      holding = null
      holdingPlain = false
      partialPlain = false
      for (const go of held.splice(0)) go()
    },
    stop: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

// A scripted OpenAI-compatible provider on loopback for the subagent browser test
// (spec/SUBAGENTS.md SA1). A workshop request calls `agent` once, then answers. A subagent's
// request (its first message is the subagent instructions) calls list_library and then waits
// until released or stopped. Synthetic text only; no real provider or key is ever used.
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export const SUBAGENT_TASK = "List every card in the library and say which one is a lighthouse keeper."
export const SUBAGENT_NAME = "lighthouse cards"
export const PARENT_ANSWER = "The subagent looked through the library for me."

interface Body {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content?: unknown }>
  readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string } }>
}

export const startSubagentProvider = async () => {
  const bodies: Array<Body> = []
  const held: Array<ServerResponse> = []
  const chunk = (delta: object, finish: string | null = null, usage?: object) =>
    `data: ${JSON.stringify({
      id: "subagent",
      object: "chat.completion.chunk",
      model: "workshop-small",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {})
    })}\n\n`
  const usage = { prompt_tokens: 200, completion_tokens: 10 }
  const send = (res: ServerResponse, parts: ReadonlyArray<string>) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(parts.join("") + "data: [DONE]\n\n")
  }
  const call = (res: ServerResponse, id: string, name: string, args: object) =>
    send(res, [
      chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
      }),
      chunk({}, "tool_calls"),
      chunk({}, null, usage)
    ])
  const text = (res: ServerResponse, value: string) =>
    send(res, [chunk({ role: "assistant", content: value }), chunk({}, "stop"), chunk({}, null, usage)])
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
      const results = body.messages.filter((m) => m.role === "tool").length
      const child = JSON.stringify(body.messages[0]?.content ?? "").includes("You are a subagent")
      if (child) {
        if (results === 0) return call(res, "child_1", "list_library", { kind: "card" })
        // Waits for Stop (the connection closes) or release.
        held.push(res)
        return
      }
      const workshop = body.tools?.some((t) => t.function.name === "agent") === true
      if (!workshop) return text(res, "Ready.")
      const from = body.messages.findLastIndex((m) => m.role === "user")
      const done = body.messages.slice(Math.max(0, from)).filter((m) => m.role === "tool").length
      if (done === 0)
        return call(res, "call_agent", "agent", { type: "research", task: SUBAGENT_TASK, name: SUBAGENT_NAME })
      return text(res, PARENT_ANSWER)
    })
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    bodies,
    heldCount: () => held.filter((r) => !r.destroyed && !r.writableEnded).length,
    /** The tool results the last workshop request carried back. */
    lastResults: () =>
      (
        bodies.filter((b) => !JSON.stringify(b.messages[0]?.content ?? "").includes("You are a subagent")).at(-1)
          ?.messages ?? []
      )
        .filter((m) => m.role === "tool")
        .map((m) => JSON.stringify(m.content)),
    stop: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

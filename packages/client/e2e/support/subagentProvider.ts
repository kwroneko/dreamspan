// A scripted OpenAI-compatible provider on loopback for the subagent browser test
// (spec/SUBAGENTS.md SA1). A workshop request calls `agent` once, then answers. A subagent's
// request (its first message is the subagent instructions) calls list_library and then waits
// until released or stopped. Synthetic text only; no real provider or key is ever used.
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export const SUBAGENT_TASK = "List every card in the library and say which one is a lighthouse keeper."
export const SUBAGENT_NAME = "lighthouse cards"
export const PARENT_ANSWER = "The subagent looked through the library for me."
export const SUBAGENT_REPORT = "Found the card of the lighthouse keeper."
/** SA5: what the reply says before it waits for a background subagent, and after its report. */
export const BACKGROUND_WAITING = "I've asked a helper to look; I'll sum up when it reports."
export const BACKGROUND_ANSWER = "The helper reported back: the keeper's card is in the library."
export const SUBAGENT_PROGRESS = "Read 1 of 2 shelves"

interface Body {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content?: unknown }>
  readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string } }>
}

export const startSubagentProvider = async () => {
  const bodies: Array<Body> = []
  const held: Array<ServerResponse> = []
  /** Once set, a subagent's request after its call reports instead of waiting. */
  let reports = false
  /** Set: the subagent reads this chat first (reading chats asks first), instead of the library. */
  let reads: string | null = null
  /** Set: the reply starts its subagent in the background, writes, waits, then sums up (SA5). */
  let background = false
  /** Set: the reply starts its subagent as a fork of its conversation (SA7, §2.3). */
  let fork = false
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
      const child =
        JSON.stringify(body.messages[0]?.content ?? "").includes("You are a subagent") ||
        JSON.stringify(body.messages).includes("From here on you are a subagent")
      if (child && background) {
        if (results === 0) return call(res, "child_progress", "report_progress", { text: SUBAGENT_PROGRESS })
        if (results === 1) return call(res, "child_1", "list_library", { kind: "card" })
        if (reports) return text(res, SUBAGENT_REPORT)
        held.push(res)
        return
      }
      if (child) {
        if (results === 0)
          return reads
            ? call(res, "child_1", "read_chat", { chat: reads })
            : call(res, "child_1", "list_library", { kind: "card" })
        if (reports) return text(res, SUBAGENT_REPORT)
        // Waits for Stop (the connection closes) or release.
        held.push(res)
        return
      }
      const workshop = body.tools?.some((t) => t.function.name === "agent") === true
      if (!workshop) return text(res, "Ready.")
      const from = body.messages.findLastIndex((m) => m.role === "user")
      const done = body.messages.slice(Math.max(0, from)).filter((m) => m.role === "tool").length
      if (background) {
        const reported = body.messages.some(
          (m) => m.role === "user" && JSON.stringify(m.content ?? "").includes("finished:")
        )
        if (reported) return text(res, BACKGROUND_ANSWER)
        const started = body.messages.some(
          (m) => m.role === "tool" && JSON.stringify(m.content ?? "").includes("in the background")
        )
        if (!started)
          return call(res, "call_agent", "agent", {
            type: "research",
            task: SUBAGENT_TASK,
            name: SUBAGENT_NAME,
            background: true
          })
        return text(res, BACKGROUND_WAITING)
      }
      if (done === 0)
        return call(res, "call_agent", "agent", {
          type: "research",
          task: SUBAGENT_TASK,
          name: SUBAGENT_NAME,
          ...(fork ? { context: "fork" } : {})
        })
      return text(res, PARENT_ANSWER)
    })
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    bodies,
    /** From now on the subagent reports after its call (held requests stay held). */
    report: () => {
      reports = true
    },
    /** Back to the start: the subagent lists the library, then waits. */
    reset: () => {
      reports = false
      reads = null
      background = false
      fork = false
    },
    /** SA5: the reply starts its subagent in the background, which shows progress, lists, then waits. */
    inBackground: () => {
      background = true
    },
    /** The reply starts its subagent as a fork of its conversation, which reports after its call. */
    forked: () => {
      fork = true
      reports = true
    },
    /** Answers the held subagent requests with the report, and reports from now on. */
    release: () => {
      reports = true
      for (const res of held.splice(0)) if (!res.destroyed && !res.writableEnded) text(res, SUBAGENT_REPORT)
    },
    /** The subagent's first call reads this chat, which asks first. */
    readChat: (chatId: string) => {
      reads = chatId
    },
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

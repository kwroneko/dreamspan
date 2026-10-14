// A slow, synthetic reasoning model with native assistant prefill, for Continue's browser tests.
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

export const THOUGHT =
  "Mira keeps the ledger closed until the rain stops. She should ask about the bridge and leave room for the traveler to answer."
const START = "The ledger says otherwise, and Mira points to the north road. "
export const MORE = " She closes the book. Before the watch changes, we should leave."

export const startContinueProvider = async () => {
  let holdNext = false
  const requests: Array<{
    messages: Array<{ role: string; content: string; prefix?: boolean }>
    tools?: Array<{ function: { parameters: { properties: { text: { description: string } } } } }>
  }> = []
  const server = createServer((req, res) => {
    if (req.url !== "/v1/chat/completions" && req.url !== "/beta/chat/completions") return res.writeHead(404).end()
    let body = ""
    req.on("data", (chunk: Buffer) => (body += chunk.toString()))
    req.on("end", () => {
      const parsed = JSON.parse(body) as (typeof requests)[number]
      requests.push(parsed)
      const prefix = parsed.tools?.[0]?.function.parameters.properties.text.description
      const continuing = prefix !== undefined || parsed.messages.at(-1)?.role === "assistant"
      const hold = holdNext && !continuing
      holdNext = false
      const tokens = [
        ...(continuing ? `Finish the thought. ${THOUGHT}` : THOUGHT)
          .match(/\S+\s*/g)!
          .map((t) => ({ reasoning_content: t })),
        ...(prefix === undefined
          ? (continuing ? MORE : START.repeat(8)).match(/\s*\S+\s*/g)!.map((t) => ({ content: t }))
          : Array.from(JSON.stringify({ text: prefix + MORE }), (t, index) => ({
              tool_calls: [
                {
                  index: 0,
                  ...(index === 0
                    ? { id: "call_1", type: "function", function: { name: "continue_reply", arguments: t } }
                    : { function: { arguments: t } })
                }
              ]
            })))
      ]
      const write = (delta: object, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: "synthetic",
            object: "chat.completion.chunk",
            model: "native-prefill",
            choices: [{ index: 0, delta, finish_reason: finish }]
          })}\n\n`
        )
      res.writeHead(200, { "content-type": "text/event-stream" })
      let i = 0
      // Stop workflows hold after some real streamed text, avoiding a moving target on phones.
      const holdAt = tokens.findIndex((token) => "content" in token) + 8
      const timer = setInterval(() => {
        if (hold && i >= holdAt) return
        if (i < tokens.length) {
          write(i === 0 ? { role: "assistant", ...tokens[i++] } : tokens[i++]!)
        } else {
          clearInterval(timer)
          write({}, prefix === undefined ? "stop" : "tool_calls")
          res.end("data: [DONE]\n\n")
        }
      }, 60)
      res.on("close", () => clearInterval(timer))
    })
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    holdNextReply: () => {
      holdNext = true
    },
    stop: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

// A fake Anthropic Messages endpoint that enforces signed thinking the way the API documents
// it (preserved thinking's history-editing check): a thinking or redacted_thinking block is
// valid only while the system prompt, the set of tools and every message before it are what
// they were when it was written, and while the signed block before it is the one it followed.
// Removing a leading run, a trailing run or all blocks is allowed; one from the middle is not.
// It also plays an older model on request: a continued tool turn must start with its thinking.
// Its own canonical form is written independently of the app's (src/providers/thinkingBinding.ts).
import { createHash, randomUUID } from "node:crypto"
import type { ServerResponse } from "node:http"
import { anthropicSse, json, type Recorded } from "./mockProvider.ts"

type Block = Record<string, unknown> & { type: string }
type Message = { role: string; content: string | Array<Block> }
export type AnthropicBody = {
  system?: unknown
  tools?: Array<{ name: string } & Record<string, unknown>>
  messages: Array<Message>
  model: string
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => key !== "cache_control")
        .sort()
        .map((key) => [key, canonical(record[key])])
    )
  }
  return value
}
const isSigned = (block: Block) => block.type === "thinking" || block.type === "redacted_thinking"
const signatureOf = (block: Block) => String(block.type === "redacted_thinking" ? block.data : block.signature)
const blocks = (message: Message): Array<Block> =>
  typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content

/** What the request before message `index` is bound to. */
export const prefixOf = (body: AnthropicBody, index: number) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          system: typeof body.system === "string" ? [{ type: "text", text: body.system }] : (body.system ?? null),
          tools: [...(body.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
          messages: body.messages
            .slice(0, index)
            .map((m) => ({ role: m.role, content: blocks(m).filter((b) => !isSigned(b)) }))
        })
      )
    )
    .digest("hex")

export interface Issued {
  readonly prefix: string
  readonly prev: string | null
}

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly message: string }

/** The documented check, over a request body and the signatures this fake issued. */
export const verify = (
  body: AnthropicBody,
  issued: ReadonlyMap<string, Issued>,
  options: { readonly needsTurnThinking?: boolean } = {}
): Verdict => {
  let lastKept: string | null = null
  for (const [index, message] of body.messages.entries()) {
    if (message.role !== "assistant") continue
    for (const [at, block] of blocks(message).entries()) {
      if (!isSigned(block)) continue
      const signature = signatureOf(block)
      const known = issued.get(signature)
      const where = `messages.${index}.content.${at}`
      if (!known) return { ok: false, message: `${where}: Invalid \`signature\` in \`thinking\` block.` }
      if (known.prefix !== prefixOf(body, index) || (lastKept !== null && known.prev !== lastKept))
        return {
          ok: false,
          message: `${where}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. Remove the block, or set \`thinking.block_binding.prefix_mismatch_behavior\` to "drop_block".`
        }
      lastKept = signature
    }
  }
  if (options.needsTurnThinking) {
    // The last assistant turn with a tool call, when tool results follow it: it must start with thinking.
    const at = body.messages.findLastIndex((m) => m.role === "assistant")
    const turn = at < 0 ? undefined : body.messages[at]
    if (turn && blocks(turn).some((b) => b.type === "tool_use") && !isSigned(blocks(turn)[0]!))
      return {
        ok: false,
        message: `messages.${at}.content.0.type: Expected \`thinking\` or \`redacted_thinking\`, but found \`tool_use\`. When \`thinking\` is enabled, a final \`assistant\` message must start with a thinking block.`
      }
  }
  return { ok: true }
}

const start = (model: string) => ({
  type: "message_start",
  message: {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    usage: { input_tokens: 10, output_tokens: 1 }
  }
})

/** The endpoint: what to answer is the test's (`reply`), the check and the signatures are its own. */
export const enforcingAnthropic = (options: {
  readonly reply: (body: AnthropicBody) => {
    readonly thinking: string
    readonly call?: { name: string; input: unknown }
    readonly text?: string
  }
  readonly needsTurnThinking?: () => boolean
}) => {
  const issued = new Map<string, Issued>()
  const verdicts: Array<{ readonly body: AnthropicBody; readonly verdict: Verdict }> = []
  const handler = (request: Recorded, res: ServerResponse) => {
    if (!request.path.startsWith("/v1/messages")) return json(res, 404, {})
    const body = request.body as unknown as AnthropicBody
    const verdict = verify(body, issued, { needsTurnThinking: options.needsTurnThinking?.() ?? false })
    verdicts.push({ body, verdict })
    if (!verdict.ok)
      return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: verdict.message } })
    const answer = options.reply(body)
    const signature = `sig-${randomUUID()}`
    // The block follows the last signed block this request carried.
    const prev =
      body.messages
        .flatMap((m) => (m.role === "assistant" ? blocks(m).filter(isSigned).map(signatureOf) : []))
        .at(-1) ?? null
    issued.set(signature, { prefix: prefixOf(body, body.messages.length), prev })
    const events: Array<{ type: string } & Record<string, unknown>> = [
      start(body.model),
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: answer.thinking } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } },
      { type: "content_block_stop", index: 0 }
    ]
    if (answer.call)
      events.push(
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: `toolu_${randomUUID().slice(0, 8)}`,
            name: answer.call.name,
            input: {}
          }
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(answer.call.input) }
        },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
        { type: "message_stop" }
      )
    else
      events.push(
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: answer.text ?? "Done." } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
        { type: "message_stop" }
      )
    anthropicSse(res, events)
  }
  return { handler, issued, verdicts }
}

// A fake Anthropic Messages endpoint that enforces signed thinking the way the API documents
// it (preserved thinking's prefix check): a thinking or redacted_thinking block is valid only
// while system, ordered tools and preceding non-thinking content match the request that
// produced it, and each sent block but the first follows the same block it followed then.
// Signatures themselves are not part of later blocks' prefixes. `relaxed` plays an earlier
// model, which checks only that the signature is its own. With
// `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` and its beta, a failing block
// is dropped and listed in `input_transformations` instead of refused.
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
    return Object.fromEntries(Object.keys(record).map((key) => [key, canonical(record[key])]))
  }
  return value
}
const unmark = (block: Block): Block => {
  const { cache_control: _marker, ...rest } = block
  return block.type === "tool_result" && Array.isArray(block.content)
    ? { ...rest, content: (block.content as Array<Block>).map(unmark) }
    : rest
}
const isSigned = (block: Block) => block.type === "thinking" || block.type === "redacted_thinking"
const signatureOf = (block: Block) => String(block.type === "redacted_thinking" ? block.data : block.signature)
const blocks = (message: Message): Array<Block> =>
  typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content

/** The independent fake compares the actual JSON data, with only API cache markers removed. */
const prefixData = (body: AnthropicBody, index: number, within: Array<Block> = []) =>
  canonical({
    model: body.model,
    system: Array.isArray(body.system) ? (body.system as Array<Block>).map(unmark) : (body.system ?? null),
    tools: (body.tools ?? []).map((t) => {
      const { cache_control: _marker, ...rest } = t
      return rest
    }),
    messages: body.messages.slice(0, index).map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : m.content.filter((b) => !isSigned(b)).map(unmark)
    })),
    ...(within.length ? { within: within.map(unmark) } : {})
  })

export const prefixOf = (body: AnthropicBody, index: number, within: Array<Block> = []) =>
  createHash("sha256")
    .update(JSON.stringify(prefixData(body, index, within)))
    .digest("hex")

const firstDifference = (before: unknown, now: unknown, path = ""): string | null => {
  if (JSON.stringify(before) === JSON.stringify(now)) return null
  if (before && now && typeof before === "object" && typeof now === "object") {
    const left = before as Record<string, unknown>,
      right = now as Record<string, unknown>
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])]) {
      const found = firstDifference(left[key], right[key], path ? `${path}.${key}` : key)
      if (found) return found
    }
  }
  return path || "request"
}

export interface Issued {
  readonly within?: Array<Block>
  readonly source?: AnthropicBody
  readonly prefix: string
  readonly prev: string | null
}

export type Verdict =
  { readonly ok: true; readonly dropped?: ReadonlyArray<string> } | { readonly ok: false; readonly message: string }

/** The documented check, over a request body and the signatures this fake issued. */
export const verify = (
  body: AnthropicBody,
  issued: ReadonlyMap<string, Issued>,
  options: {
    readonly needsTurnThinking?: boolean
    readonly relaxed?: boolean
    readonly chain?: boolean
    readonly dropBlocks?: boolean
  } = {}
): Verdict => {
  const dropped: Array<string> = []
  // The last signed block sent before this one, and whether one was.
  let previous: string | null = null
  let any = false
  for (const [index, message] of body.messages.entries()) {
    if (message.role !== "assistant") continue
    for (const [at, block] of blocks(message).entries()) {
      if (!isSigned(block)) continue
      const signature = signatureOf(block)
      const known = issued.get(signature)
      const where = `messages.${index}.content.${at}`
      if (!known) return { ok: false, message: `${where}: Invalid \`signature\` in \`thinking\` block.` }
      if (options.relaxed) continue
      if (options.chain && any && known.prev !== previous) {
        if (options.dropBlocks) {
          dropped.push(where)
          continue
        }
        return {
          ok: false,
          message: `${where}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. An earlier thinking block is missing or out of order.`
        }
      }
      if (
        known.prefix !==
        prefixOf(
          body,
          index,
          blocks(message)
            .slice(0, at)
            .filter((b) => !isSigned(b))
        )
      ) {
        if (options.dropBlocks) {
          dropped.push(where)
          continue
        }
        return {
          ok: false,
          message: `${where}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. Content before this block differs from when it was created, first at ${
            known.source
              ? firstDifference(
                  prefixData(known.source, known.source.messages.length, known.within),
                  prefixData(
                    body,
                    index,
                    blocks(message)
                      .slice(0, at)
                      .filter((b) => !isSigned(b))
                  )
                )
              : "request"
          }.`
        }
      }
      previous = signature
      any = true
    }
  }
  if (options.needsTurnThinking && (body as { thinking?: { type?: string } }).thinking?.type === "enabled") {
    // The last assistant turn with a tool call, when tool results follow it: it must start with thinking.
    const at = body.messages.findLastIndex((m) => m.role === "assistant")
    const turn = at < 0 ? undefined : body.messages[at]
    if (turn && blocks(turn).some((b) => b.type === "tool_use") && !isSigned(blocks(turn)[0]!))
      return {
        ok: false,
        message: `messages.${at}.content.0.type: Expected \`thinking\` or \`redacted_thinking\`, but found \`tool_use\`. When \`thinking\` is enabled, a final \`assistant\` message must start with a thinking block.`
      }
  }
  return dropped.length ? { ok: true, dropped } : { ok: true }
}

const start = (model: string, transformations?: ReadonlyArray<string>) => ({
  type: "message_start",
  message: {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    usage: { input_tokens: 10, output_tokens: 1 },
    ...(transformations
      ? {
          input_transformations: transformations.map((path) => ({
            type: "thinking_dropped",
            path,
            reason: "prefix_binding_mismatch"
          }))
        }
      : {})
  }
})

const BINDING_BETA = "thinking-binding-controls-2026-08-01"

/** The endpoint: what to answer is the test's (`reply`), the check and the signatures are its own. */
export const enforcingAnthropic = (options: {
  readonly reply: (body: AnthropicBody) => {
    readonly thinking: string
    readonly call?: { name: string; input: unknown }
    readonly text?: string
  }
  readonly needsTurnThinking?: () => boolean
  /** An earlier model: only the signature is checked. */
  readonly relaxed?: boolean
  /** Also check that the blocks sent are an unbroken run. */
  readonly chain?: boolean
  /** Blocks to report dropped besides its own finding (with the binding beta), by path. */
  readonly reportDropped?: (body: AnthropicBody) => ReadonlyArray<string>
}) => {
  const issued = new Map<string, Issued>()
  const verdicts: Array<{ readonly body: AnthropicBody; readonly verdict: Verdict }> = []
  const handler = (request: Recorded, res: ServerResponse) => {
    if (!request.path.startsWith("/v1/messages")) return json(res, 404, {})
    const body = request.body as unknown as AnthropicBody
    const beta = String(request.headers["anthropic-beta"] ?? "")
      .split(",")
      .map((b) => b.trim())
      .includes(BINDING_BETA)
    const binding = (body as { thinking?: { block_binding?: { prefix_mismatch_behavior?: string } } }).thinking
      ?.block_binding
    if (binding && !beta)
      return json(res, 400, {
        type: "error",
        error: { type: "invalid_request_error", message: "thinking.block_binding: Extra inputs are not permitted" }
      })
    const verdict = verify(body, issued, {
      needsTurnThinking: options.needsTurnThinking?.() ?? false,
      relaxed: options.relaxed ?? false,
      chain: options.chain ?? false,
      dropBlocks: binding?.prefix_mismatch_behavior === "drop_block"
    })
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
    issued.set(signature, { prefix: prefixOf(body, body.messages.length), prev, source: structuredClone(body) })
    const events: Array<{ type: string } & Record<string, unknown>> = [
      start(body.model, beta ? [...(verdict.dropped ?? []), ...(options.reportDropped?.(body) ?? [])] : undefined),
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

import { Effect } from "effect"
import { summaryWords } from "@rp/shared/lcmSettings.ts"
import type { AssemblyTransform } from "../assembler/pipeline.ts"
import type { ContextSnapshot, Piece, RequestMessage } from "../assembler/types.ts"
import { DIRECT_INSTRUCTION, TOOL_INSTRUCTION } from "./instructions.ts"
import { applySummaryPrefix } from "./prefix.ts"

const summaryTail = (snapshot: ContextSnapshot): ContextSnapshot => {
  const job = snapshot.summaryJob!
  const request = snapshot.request
  return {
    ...snapshot,
    request: {
      ...request,
      prefill: null,
      messages: [
        ...request.messages,
        {
          role:
            snapshot.inputs.model?.mapping?.midChatSystem === true ||
            (snapshot.inputs.model?.mapping?.midChatSystem === undefined &&
              snapshot.inputs.model?.api === "openai-completions")
              ? "system"
              : "user",
          content: job.tail
        }
      ],
      breakpoints: request.breakpoints.filter((b) => b.reason !== "history")
    }
  }
}

const element = (p: Piece) =>
  p.source.kind === "summary"
    ? `<summary level="${p.source.level}" from="${p.source.from}" to="${p.source.to}">\n${p.text}\n</summary>`
    : p.text

/** Summaries as one block, as our layouts send the layer. */
const block = (pieces: ReadonlyArray<Piece>) => `<summaries>\n${pieces.map(element).join("\n")}\n</summaries>`

/**
 * A summary request without the preset (DESIGN §8; ST's "Raw"): the instruction as the system
 * message, the earlier coverage as continuity, one message per summary, then the material: a
 * level-1 job's messages in their roles, or a condensation's parts as one block. Built from the
 * assembled context, so the chunk is exactly the one the full-preset path would render and clip;
 * nothing of the preset, cards or notes is sent. It shares no prefix with the chat: its own
 * breakpoint after the continuity lets the next chunk read it back, since that chunk's request
 * repeats these messages and adds the new summary after them (one message for all of them would
 * change with every summary, and a provider cache matches whole messages).
 */
const rawSummary = (snapshot: ContextSnapshot): ContextSnapshot => {
  const job = snapshot.summaryJob!
  const request = snapshot.request
  const summaries = snapshot.pieces.flatMap((p, at) => (p.source.kind === "summary" && p.text !== "" ? [at] : []))
  const parts = job.children?.length ?? 0
  const continuity = summaries.slice(0, summaries.length - parts)
  const material = parts ? summaries.slice(-parts) : []
  const messages: Array<RequestMessage> = [{ role: "system", content: job.tail }]
  const placed = new Map<number, Array<number>>()
  const place = (pieces: ReadonlyArray<number>) => {
    messages.push({ role: "user", content: block(pieces.map((at) => snapshot.pieces[at]!)) })
    for (const at of pieces) placed.set(at, [messages.length - 1])
  }
  for (const at of continuity) {
    messages.push({ role: "user", content: element(snapshot.pieces[at]!) })
    placed.set(at, [messages.length - 1])
  }
  const cached = messages.length - 1
  // A message is history when it holds a message piece; its index in the new request.
  const moved = new Map<number, number>()
  if (parts) place(material)
  else
    request.messages.forEach((message, at) => {
      if (snapshot.pieces.some((p) => p.source.kind === "message" && p.messages.includes(at))) {
        moved.set(at, messages.length)
        messages.push(message)
      }
    })
  // Every piece keeps its index (a piece's `parts` name others by it); unsent ones hold no message.
  const pieces: Array<Piece> = [
    ...snapshot.pieces.map((p, at) => ({
      ...p,
      messages: placed.get(at) ?? p.messages.flatMap((i) => (moved.has(i) ? [moved.get(i)!] : []))
    })),
    {
      id: "lcm:instruction",
      source: { kind: "assembler", what: "summary instruction" },
      text: job.tail,
      messages: [0]
    }
  ]
  const { summaryStart: _start, ...rest } = request
  return {
    ...snapshot,
    pieces,
    request: {
      ...rest,
      prefill: null,
      messages,
      ...(continuity.length ? { summaryStart: 1 } : {}),
      breakpoints: [{ message: cached, reason: continuity.length ? "summary" : "prefix" }]
    }
  }
}

/** The request a summary job sends: with the chat's preset and its pinned prefix, or without the preset. */
const summaryRequest = (snapshot: ContextSnapshot): ContextSnapshot =>
  snapshot.summaryJob?.withPreset === false
    ? rawSummary(snapshot)
    : summaryTail(applySummaryPrefix(snapshot, snapshot.summaryJob?.prefix))

/** The registered default owns instruction rendering, prefix reuse and raw/full shaping. */
export const summaryRequestTransform: AssemblyTransform = {
  id: "summary-request",
  run: (snapshot, request) =>
    Effect.sync(() => {
      if (!snapshot.summaryJob) return snapshot
      const job = snapshot.summaryJob
      const instruction = request.summaryInstruction
      if (instruction) {
        const count = job.children?.length ?? 0
        const range = instruction.range ? `(messages ${instruction.range.from} to ${instruction.range.to})` : ""
        const text = count
          ? job.withPreset === false
            ? `Condense the last ${count} summaries ${range} into one summary of at most ${summaryWords(instruction.target)} words. Keep their language and voice, names, events and unresolved details. Any summaries before them are continuity, not material to condense again.`
            : `Condense the last ${count} summaries above ${range} into one summary of at most ${summaryWords(instruction.target)} words. Keep its language and voice, names, events and unresolved details. The earlier summaries are continuity, not material to condense again.`
          : job.tail
        snapshot = {
          ...snapshot,
          summaryJob: {
            ...job,
            tail:
              text.replace(/\{\{words\}\}/gi, String(summaryWords(instruction.target))) +
              (instruction.output ?? (job.style === "tool" ? TOOL_INSTRUCTION : DIRECT_INSTRUCTION))
          },
          request: {
            ...snapshot.request,
            samplers: { ...snapshot.request.samplers, max_tokens: Math.ceil(instruction.target * 2.5) }
          }
        }
      }
      return summaryRequest(snapshot)
    })
}

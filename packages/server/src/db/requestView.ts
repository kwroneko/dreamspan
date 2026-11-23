// A request not sent (a chat's first, or a chat's next reply), mapped for the model's API as the
// inspector shows a sent one, and its size by part for the next-reply strip's context chip.
// Counted with the local tokenizers (`textDisplay`): nothing here reaches a provider.
import { endOfRequestText } from "@dreamspan/shared/endOfRequest.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { ContextSource, DraftRequest, RequestSize } from "@dreamspan/shared/inspectorApi.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { Assembler } from "../assembler/assembler.ts"
import { wireImages } from "../assembler/imageTokens.ts"
import { inspectWire } from "../assembler/inspection.ts"
import type { ContextSnapshot, ModelInput, Source } from "../assembler/types.ts"
import { wireContext } from "../assembler/wire.ts"
import { contextMessages, inspectionInputs, sourceId } from "./inspectorReads.ts"
import { textDisplay } from "./textDisplay.ts"

/** The request view's total: what the boundary line, the context chip and the preview say. */
export const requestTotal = (request: Pick<DraftRequest, "messages">) =>
  request.messages.reduce((sum, message) => sum + message.tokens, 0)

/** The request `built` would send, as the inspector shows one; `link` maps each source (unlinked for a draft). */
export const requestView = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  assembler: Assembler,
  built: ContextSnapshot,
  model: ModelInput,
  now: number,
  link?: (source: ContextSource) => ContextSource
) => requestViewCounted(sql, userId, assembler, built, model, now, link).pipe(Effect.map((view) => view.request))

/**
 * The request view, and the calibrated count of each text it counted, so the cache estimate
 * counts the same messages to the same number.
 */
export const requestViewCounted = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  assembler: Assembler,
  built: ContextSnapshot,
  model: ModelInput,
  now: number,
  link: (source: ContextSource) => ContextSource = (source) => source
) =>
  Effect.gen(function* () {
    const inspection = yield* inspectionInputs(sql, userId, built, assembler)
    const wire = inspectWire(wireContext(built.request, model), built.request, inspection, (text) => text)
    const texts = wire.messages.map((m) => m.content + (m.name ?? ""))
    const counts = yield* textDisplay(sql, userId, model, assembler, texts, now)
    const request: DraftRequest = {
      builtAt: now,
      type: built.inputs.type,
      mode: built.inputs.mode,
      tokenizer: counts.tokenizer,
      messages: contextMessages(wire, wireImages(wire.messages, built.request), counts.counts, link),
      samplers: { ...wire.samplers },
      ...wire.display!,
      ...(wire.display?.notSent ? { notSent: wire.display.notSent.map(link) } : {})
    }
    const counted = new Map(texts.map((text, i) => [text, counts.counts[i] ?? 0] as const))
    return { request, counted: counted as ReadonlyMap<string, number> }
  })

interface Part {
  readonly id: string
  readonly label: string
}
const FORMATTING: Part = { id: "formatting", label: "Formatting" }
const IMAGES: Part = { id: "images", label: "Images" }
const PARTS: Record<string, Part> = {
  end: { id: "end", label: "End of request" },
  preset: { id: "preset", label: "Preset prompts" },
  examples: { id: "examples", label: "Example dialogues" },
  persona: { id: "persona", label: "Persona" },
  cards: { id: "cards", label: "Character cards" },
  lorebook: { id: "lorebook", label: "Lorebook" },
  notes: { id: "notes", label: "Notes" },
  summaries: { id: "summaries", label: "Summaries" },
  history: { id: "history", label: "Chat history" },
  guidance: { id: "guidance", label: "Guidance" }
}

/** The part a source's text counts toward in the breakdown. */
const partOf = (source: Source): Part => {
  switch (source.kind) {
    case "preset":
      return endOfRequestText(source.identifier) ? PARTS.end! : PARTS.preset!
    case "card":
      return source.field === "mes_example" ? PARTS.examples! : source.persona ? PARTS.persona! : PARTS.cards!
    case "lorebook":
      return PARTS.lorebook!
    case "note":
      return PARTS.notes!
    case "summary":
      return PARTS.summaries!
    case "message":
      return PARTS.history!
    case "direction":
      return PARTS.guidance!
    case "assembler":
      return FORMATTING
  }
  // A plugin's own kind (<plugin-id>/<kind>), by the kind's name.
  const name = source.kind.slice(source.kind.indexOf("/") + 1).replaceAll(/[-_]/g, " ")
  return { id: source.kind, label: name.charAt(0).toUpperCase() + name.slice(1) }
}

/**
 * `request`'s tokens by part. The counts are per message, as the request view shows them, so each
 * message's is shared among its parts by their share of its text; the text between parts (joins,
 * a block's frames and wrappers) and each message's framing are formatting, its images images.
 * The parts come from the assembler's own pieces, so a plugin's source is a part of its own.
 * `messagesBefore`: the messages on the path before the reply, for "N of M messages".
 */
export const requestSize = (
  built: Pick<ContextSnapshot, "pieces">,
  request: Pick<DraftRequest, "messages" | "tokenizer">,
  messagesBefore: number
): RequestSize => {
  const partOfSource = new Map<string, Part>()
  for (const piece of built.pieces) partOfSource.set(sourceId(piece.source), partOf(piece.source))
  const totals = new Map<string, { part: Part; tokens: number }>()
  const add = (part: Part, tokens: number) => {
    if (tokens <= 0) return
    const entry = totals.get(part.id)
    if (entry) entry.tokens += tokens
    else totals.set(part.id, { part, tokens })
  }
  const sent = new Set<string>()
  for (const message of request.messages) {
    for (const source of message.sources)
      if (source.kind === "message" && source.slotId !== null) sent.add(source.slotId)
    // As `contextMessages` counts a message: its text's tokens, 3 for its framing, its images.
    const images = Math.min(
      message.tokens,
      message.images?.reduce((n, image) => n + (image.sent ? image.budgeted : 0), 0) ?? 0
    )
    add(IMAGES, images)
    const framing = message.content ? Math.min(3, message.tokens - images) : 0
    const text = message.tokens - images - framing
    const of = (index: number) => {
      const source = message.sources[index]
      return (source && partOfSource.get(source.id)) ?? FORMATTING
    }
    const chars = new Map<Part, number>()
    if (message.parts === undefined) {
      // No parts recorded: the message is its first source's.
      if (message.sources.length > 0) chars.set(of(0), message.content.length)
    } else
      for (const part of message.parts)
        if (!part.frame)
          chars.set(of(part.source), (chars.get(of(part.source)) ?? 0) + Math.max(0, part.end - part.start))
    const whole = Math.max(
      message.content.length,
      [...chars.values()].reduce((n, c) => n + c, 0)
    )
    let given = 0
    for (const [part, n] of chars) {
      const tokens = whole === 0 ? 0 : Math.floor((text * n) / whole)
      given += tokens
      add(part, tokens)
    }
    add(FORMATTING, text - given + framing)
  }
  return {
    tokens: request.messages.reduce((n, m) => n + m.tokens, 0),
    parts: [...totals.values()]
      .map(({ part, tokens }) => ({ id: part.id, label: part.label, tokens }))
      .sort((a, b) => b.tokens - a.tokens),
    messages: { sent: sent.size, total: Math.max(sent.size, messagesBefore) },
    ...(request.tokenizer ? { tokenizer: request.tokenizer } : {})
  }
}

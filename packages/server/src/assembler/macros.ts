// Macro expansion by source (DESIGN §5.6, ARCHITECTURE §10), for the assembler. Preset and
// card text expands; a message of the path expands only when its stored mode is
// `template`. Every piece is expanded on its own, with the variables the pieces before it
// left, and its random and time draws are kept per piece so the context can be built again
// identically. A piece that reaches a limit is dropped and reported, not the whole turn.
import type { CardFields, ChatMessage, MacroContext } from "@rp/shared/macros/context.ts"
import { expand, type TextOrigin } from "@rp/shared/macros/expand.ts"
import type { Assembly } from "./pipeline.ts"
import type { CardInput, HistoryEntry, Source } from "./types.ts"

export interface Names {
  readonly user: string
  readonly char: string
  readonly group?: string
  readonly groupNotMuted?: string
  readonly notChar?: string
}

interface ExpandOptions {
  /** Bindings for this piece only, such as the tail directive's speaker. */
  readonly names?: Partial<Names>
  /** `{{original}}`: the text a card's prompt override replaces. */
  readonly original?: string
  /** Expand without card fields, as ST's baseChatReplace expands a card's own fields. */
  readonly withoutCard?: boolean
  /** The card whose fields macros read, when not the context's (a card's own block). */
  readonly card?: CardFields
}

export interface MacroEnvironment {
  readonly names: Names
  /** Expands preset or card text at the generation's position and records it as a piece. */
  readonly piece: (id: string, source: Source, text: string, options?: ExpandOptions) => number
  /**
   * Records text that isn't expanded (the user's own text, the assembler's), and the pieces
   * whose text it holds.
   */
  readonly verbatim: (id: string, source: Source, text: string, parts?: ReadonlyArray<number>) => number
  /**
   * Records a message of the path: verbatim unless its mode is `template`. A template expands
   * with the chat as it was at its position: `before` are the messages before it, and `at`
   * the names, card and variables there.
   */
  readonly message: (entry: HistoryEntry, before: ReadonlyArray<ChatMessage>, at?: MessagePosition) => number
  readonly text: (piece: number) => string
  /** The messages of the path, resolved, for macros that read the chat. */
  readonly setMessages: (messages: ReadonlyArray<ChatMessage>) => void
}

/** What a template message expands with: the chat's bindings, card and variables at its position. */
export interface MessagePosition {
  readonly names: Names
  readonly card: CardFields
  readonly variables: Readonly<Record<string, unknown>>
}

/** A card's fields as macros read them, stored text, unexpanded (ARCHITECTURE §10). */
export const cardFields = (card: CardInput | undefined, persona: CardInput | undefined, depthPrompt?: string) => {
  const fields: CardFields = {
    persona: persona?.doc.description ?? "",
    ...(card
      ? {
          description: card.doc.description,
          personality: card.doc.personality,
          scenario: card.doc.scenario,
          mesExamples: card.doc.mes_example,
          systemPrompt: card.doc.system_prompt,
          postHistoryInstructions: card.doc.post_history_instructions,
          depthPrompt: depthPrompt ?? "",
          creatorNotes: card.doc.creator_notes,
          version: card.doc.character_version,
          firstMessage: card.doc.first_mes,
          alternateGreetings: card.doc.alternate_greetings
        }
      : {})
  }
  return fields
}

export const makeMacroEnvironment = (
  assembly: Assembly,
  setup: {
    readonly names: Names
    readonly card: CardFields
    readonly messages: ReadonlyArray<ChatMessage>
    readonly model: string
    readonly maxContextTokens: number
    readonly maxResponseTokens: number
    readonly type: string
    readonly chatId: string
    readonly variables: Readonly<Record<string, unknown>>
  }
): MacroEnvironment => {
  const { request } = assembly
  let local: Readonly<Record<string, unknown>> = setup.variables
  let global: Readonly<Record<string, unknown>> = {}

  const record = (id: string, source: Source, text: string, parts?: ReadonlyArray<number>) => {
    assembly.pieces.push({ id, source, text, messages: [], ...(parts && parts.length > 0 ? { parts } : {}) })
    return assembly.pieces.length - 1
  }

  let base: Omit<MacroContext, "names"> = {
    card: setup.card,
    messages: setup.messages,
    now: request.now,
    timeZone: request.timeZone,
    model: setup.model,
    input: "",
    maxContextTokens: setup.maxContextTokens,
    maxResponseTokens: setup.maxResponseTokens,
    lastGenerationType: setup.type,
    isMobile: false,
    pickSeed: setup.chatId
  }

  const run = (
    id: string,
    text: string,
    origin: TextOrigin,
    context: MacroContext,
    keepEffects: boolean,
    frozen?: Readonly<Record<string, string>>
  ) => {
    const result = expand({
      text,
      origin,
      purpose: "assembly",
      registry: request.macros,
      context,
      frozen: { ...frozen, ...request.frozen[id] },
      random: request.random
    })
    if (result._tag === "LimitExceeded") {
      const where = result.scope === "" ? "" : ` in ${result.scope}`
      assembly.issues.push({
        kind: "macro_limit",
        message: `${id} was left out: its macros reached the ${result.limit} limit${where}, at offset ${result.offset}.`
      })
      return ""
    }
    if (Object.keys(result.frozen).length > 0) assembly.frozen[id] = result.frozen
    if (keepEffects) {
      local = result.variables.local
      global = result.variables.global
      assembly.effects.push(...result.effects)
    }
    return result.text
  }

  return {
    names: setup.names,
    piece: (id, source, text, options = {}) => {
      const { card, ...rest } = base
      const context: MacroContext = {
        ...rest,
        ...(options.withoutCard ? {} : { card: options.card ?? card }),
        ...(options.original !== undefined ? { original: options.original } : {}),
        names: { ...setup.names, ...options.names },
        variables: { local, global }
      }
      const origin: TextOrigin = { kind: source.kind === "preset" ? "preset" : "card" }
      return record(id, source, run(id, text, origin, context, true))
    },
    verbatim: (id, source, text, parts) => record(id, source, text, parts),
    message: (entry, before, at) => {
      const id = `message:${entry.versionId}`
      const source: Source = { kind: "message", slot: entry.slotId, version: entry.versionId }
      if (entry.macroMode !== "template") return record(id, source, entry.content)
      // What it writes was recorded when it was written, so it isn't again.
      const context: MacroContext = {
        ...base,
        ...(at ? { card: at.card } : {}),
        messages: before,
        names: at?.names ?? setup.names,
        variables: { local: at?.variables ?? local, global: {} }
      }
      return record(
        id,
        source,
        run(id, entry.content, { kind: "message", macroMode: "template" }, context, false, entry.frozen ?? undefined)
      )
    },
    text: (piece) => assembly.pieces[piece]!.text,
    setMessages: (messages) => {
      base = { ...base, messages }
    }
  }
}

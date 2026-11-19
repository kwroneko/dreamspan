// Macro expansion by source, for the assembler (DESIGN §5.6; ARCHITECTURE §10, §15).
import type { CardFields, ChatMessage, MacroContext } from "@dreamspan/shared/macros/context.ts"
import { expand, type TextOrigin } from "@dreamspan/shared/macros/expand.ts"
import type { VariableEffect } from "@dreamspan/shared/macros/variables.ts"
import type { Assembly } from "./pipeline.ts"
import { noteCard, type CardInput, type HistoryEntry, type Source, type NoteInput } from "./types.ts"
import { readReplaceTarget, targetCard } from "@dreamspan/shared/docs/note.ts"

/** Macros that read this generation's speaker or direction (conservatively, by name). */
const PER_TURN = /\{\{[^}]*\b(?:speaker|direction)\b/i
/** `{{summary}}`, which reads the summary notes. */
const SUMMARY = /\{\{\s*summary\s*\}\}/i

export interface Names {
  readonly user: string
  readonly char: string
  readonly group?: string
  readonly groupNotMuted?: string
  readonly notChar?: string
}

interface ExpandOptions {
  readonly sharedWork?: { remaining: number }
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
  /** Read-only expansion for activation; freezes draws but does not write variables. */
  readonly preview: (id: string, text: string, options?: ExpandOptions) => string
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
  /** Later variable readers may depend on an intermittent note, including when it is skipped. */
  readonly potentialVariableWrite: () => void
  readonly isVolatile: (piece: number) => boolean
  /** Dynamic prefix diagnostics do not suppress otherwise useful cache checkpoints. */
  readonly isChanging: (piece: number) => boolean
  /** A piece that comes and goes from turn to turn, such as a conditioned note's, whatever its text. */
  readonly markVolatile: (piece: number) => void
  readonly text: (piece: number) => string
  /** The card fields preset and chat text read from now on: the joined fields, once composed. */
  readonly setCard: (card: CardFields) => void
  /** The messages of the path, resolved, for macros that read the chat. */
  readonly setMessages: (messages: ReadonlyArray<ChatMessage>) => void
  /**
   * The chat's variables as they are once the path's messages wrote theirs, under what the
   * context's own macros wrote so far.
   */
  readonly rebase: (variables: Readonly<Record<string, unknown>>) => void
}

/** What a template message expands with: the chat's bindings, card and variables at its position. */
export interface MessagePosition {
  readonly names: Names
  readonly card: CardFields
  readonly variables: Readonly<Record<string, unknown>>
  /** Takes the chat variables it writes; without it, they're dropped (already recorded). */
  readonly writes?: (effects: ReadonlyArray<VariableEffect>) => void
}

/** A card's fields as macros read them, stored text, unexpanded (ARCHITECTURE §10). */
export const cardFields = (
  card: CardInput | undefined,
  persona: CardInput | undefined,
  depthPrompt?: string,
  notes: ReadonlyArray<NoteInput> = []
) => {
  const effective = (value: CardInput | undefined) => {
    if (!value) return value
    const doc = { ...value.doc }
    const seen = new Set<string>()
    for (const note of notes) {
      const target = readReplaceTarget(note.doc.replaces)
      if (
        target?.kind !== "card_field" ||
        targetCard(target, noteCard(note.doc)) !== value.entity ||
        seen.has(target.field)
      )
        continue
      seen.add(target.field)
      doc[target.field] = note.doc.own_position
        ? ""
        : note.doc.content.replace(/\{\{\s*original\s*\}\}/gi, () => value.doc[target.field])
    }
    return { ...value, doc }
  }
  card = effective(card)
  persona = effective(persona)
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
    readonly collapseNewlines: boolean
    readonly messages: ReadonlyArray<ChatMessage>
    readonly model: string
    readonly maxContextTokens: number
    readonly maxResponseTokens: number
    readonly type: string
    readonly chatId: string
    readonly variables: Readonly<Record<string, unknown>>
    readonly summary: string
    /** Whether `{{summary}}` can change from turn to turn: a summary note with a condition. */
    readonly summaryVolatile?: boolean
    /** `{{speaker}}` and `{{direction}}` (DESIGN §2.2); absent, they stay as written. */
    readonly speaker?: string | undefined
    readonly direction?: string | undefined
  }
): MacroEnvironment => {
  const { request } = assembly
  let local: Readonly<Record<string, unknown>> = setup.variables
  let global: Readonly<Record<string, unknown>> = {}
  let variableBarrier = false
  const volatilePieces = new Set<number>()
  const changingPieces = new Set<number>()
  const isVolatile = (piece: number): boolean =>
    volatilePieces.has(piece) || (assembly.pieces[piece]!.parts?.some(isVolatile) ?? false)

  const isChanging = (piece: number): boolean =>
    volatilePieces.has(piece) || changingPieces.has(piece) || (assembly.pieces[piece]!.parts?.some(isChanging) ?? false)

  const record = (id: string, source: Source, text: string, parts?: ReadonlyArray<number>) => {
    assembly.pieces.push({ id, source, text, messages: [], ...(parts && parts.length > 0 ? { parts } : {}) })
    return assembly.pieces.length - 1
  }

  let base: Omit<MacroContext, "names"> = {
    card: setup.card,
    collapseNewlines: setup.collapseNewlines,
    messages: setup.messages,
    now: request.now,
    timeZone: request.timeZone,
    model: setup.model,
    input: "",
    maxContextTokens: setup.maxContextTokens,
    maxResponseTokens: setup.maxResponseTokens,
    lastGenerationType: setup.type,
    isMobile: false,
    pickSeed: setup.chatId,
    summary: setup.summary,
    ...(setup.speaker !== undefined ? { speaker: setup.speaker } : {}),
    ...(setup.direction !== undefined ? { direction: setup.direction } : {})
  }

  const run = (
    id: string,
    text: string,
    origin: TextOrigin,
    context: MacroContext,
    /** Where its variable writes go: into the context's, or to the caller. */
    effects: "context" | ((effects: ReadonlyArray<VariableEffect>) => void),
    frozen?: Readonly<Record<string, string>>,
    sharedWork?: { remaining: number }
  ) => {
    if (sharedWork?.remaining === 0) return { text: "", readsVariables: false, readsVolatile: false }
    let readsVariables = false
    let readsVolatile = false
    const result = expand({
      text,
      ...(sharedWork ? { sharedWork } : {}),
      origin,
      purpose: "assembly",
      registry: request.macros,
      context,
      frozen: { ...frozen, ...request.frozen[id] },
      random: request.random,
      onReplacement: (macro, plugin) => {
        const message = `{{${macro}}} replaced by ${plugin} (plugin).`
        if (!assembly.issues.some((issue) => issue.kind === "plugin_replacement" && issue.message === message))
          assembly.issues.push({ kind: "plugin_replacement", message })
      },
      onVolatileRead: () => {
        readsVolatile = true
      },
      onVariableRead: () => {
        readsVariables = true
      }
    })
    if (result._tag === "LimitExceeded") {
      const where = result.scope === "" ? "" : ` in ${result.scope}`
      assembly.issues.push({
        kind: "macro_limit",
        message: `${id} was left out: its macros reached the ${result.limit} limit${where}, at offset ${result.offset}.`
      })
      return { text: "", readsVariables, readsVolatile }
    }
    if (Object.keys(result.frozen).length > 0) assembly.frozen[id] = result.frozen
    if (effects === "context") {
      local = result.variables.local
      global = result.variables.global
      assembly.effects.push(...result.effects)
    } else {
      effects(result.effects)
    }
    return { text: result.text, readsVariables, readsVolatile }
  }

  return {
    names: setup.names,
    preview: (id, text, options = {}) => {
      const { card, ...rest } = base
      return run(
        id,
        text,
        { kind: "card" },
        {
          ...rest,
          ...(options.withoutCard ? {} : { card: options.card ?? card }),
          names: { ...setup.names, ...options.names },
          variables: { local, global }
        },
        () => {},
        undefined,
        options.sharedWork
      ).text
    },
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
      const expanded = run(id, text, origin, context, "context")
      const piece = record(id, source, expanded.text)
      if (expanded.readsVolatile) changingPieces.add(piece)
      if (variableBarrier && expanded.readsVariables) volatilePieces.add(piece)
      // Who writes and the direction change from turn to turn: never inside the cached prefix.
      if (PER_TURN.test(text) || (setup.summaryVolatile && SUMMARY.test(text))) volatilePieces.add(piece)
      return piece
    },
    verbatim: (id, source, text, parts) => record(id, source, text, parts),
    message: (entry, before, at) => {
      const id = `message:${entry.versionId}`
      const source: Source = {
        kind: "message",
        slot: entry.slotId,
        version: entry.versionId,
        ...(entry.versionNumber === undefined ? {} : { number: entry.versionNumber })
      }
      if (entry.macroMode !== "template") return record(id, source, entry.content)
      // A message of the chat keeps `{{speaker}}` and `{{direction}}` as written: they're this
      // generation's, not the message's.
      const { speaker: _speaker, direction: _direction, ...chat } = base
      const context: MacroContext = {
        ...chat,
        ...(at ? { card: at.card } : {}),
        messages: before,
        names: at?.names ?? setup.names,
        variables: { local: at?.variables ?? local, global: {} }
      }
      return record(
        id,
        source,
        run(
          id,
          entry.content,
          { kind: "message", macroMode: "template" },
          context,
          (effects) => at?.writes?.(effects.filter((e) => e.scope === "local")),
          entry.frozen ?? undefined
        ).text
      )
    },
    potentialVariableWrite: () => {
      variableBarrier = true
    },
    isVolatile,
    isChanging,
    markVolatile: (piece) => {
      volatilePieces.add(piece)
    },
    text: (piece) => assembly.pieces[piece]!.text,
    setCard: (card) => {
      base = { ...base, card }
    },
    setMessages: (messages) => {
      base = { ...base, messages }
    },
    rebase: (variables) => {
      const next: Record<string, unknown> = { ...variables }
      for (const effect of assembly.effects) {
        if (effect.scope !== "local") continue
        if (effect.value === null) delete next[effect.name]
        else next[effect.name] = effect.value
      }
      local = next
    }
  }
}

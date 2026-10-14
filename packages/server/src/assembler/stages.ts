import { schemaPrefillBudget } from "./prefill.ts"
import { layerText, lcmStage } from "./lcm.ts"
import { createHash } from "node:crypto"
import { contextBudget, targetBudget, loreAllowance, loreBudget } from "./budget.ts"
// The built-in assembler stages, in registration order (ARCHITECTURE §15 lists them).
import type { ChatMessage } from "@rp/shared/macros/context.ts"
import type { CardFields } from "@rp/shared/macros/context.ts"
import type { VariableEffect } from "@rp/shared/macros/variables.ts"
import { type ChatState, foldState, noteSwitches } from "@rp/shared/state.ts"
import { Effect, type Scope } from "effect"
import { loreActivationStage, lorebooksStage } from "./loreStages.ts"
import { SUMMARY_HISTORY, summaryOnPath as selectSummary } from "./summary.ts"
import { placeBreakpoints } from "./breakpoints.ts"
import { cardBlock, directive, personaBlock } from "./layouts.ts"
import { cardFields, makeMacroEnvironment, type MessagePosition, type Names } from "./macros.ts"
import { compile, makeScriptRunner, PLACEMENT, type PromptScript, type ScriptRunner } from "./regex.ts"
import {
  type Assembly,
  type AssemblerStage,
  AssemblySources,
  type Cast,
  type Mode,
  need,
  type PositionedEvent,
  type ProjectedEntry,
  type Scripted,
  type StageRegistry
} from "./pipeline.ts"
import {
  type ChatLine,
  compose,
  disabledIn,
  exampleBlocks,
  type Injection,
  injectInChat,
  merged,
  parseExampleBlock,
  postProcess,
  sanitizeName,
  squash,
  type StMessage,
  type StPrompt,
  type Text,
  tokensOf,
  triggers
} from "./st.ts"
import {
  AssemblyFailed,
  type CardInput,
  type GenerationType,
  type HistoryEntry,
  type NoteInput,
  noteCard,
  placesDescription,
  type Target,
  type Role,
  type Source
} from "./types.ts"

/** A stage that reads nothing more; it may fail the assembly with AssemblyFailed. */
const sync = (id: string, run: (assembly: Assembly) => void): AssemblerStage => ({
  id,
  run: (assembly) =>
    Effect.suspend(() => {
      try {
        run(assembly)
      } catch (error) {
        if (error instanceof AssemblyFailed) return Effect.fail(error)
        throw error
      }
      return Effect.succeed(assembly)
    })
})

/** How many messages one read of the path takes. */
const HISTORY_WINDOW = 200

const clipForSummary = (assembly: Assembly, text: string) => {
  const cap = assembly.request.summaryClipTokens
  if (cap === undefined || text.length <= cap * 4) return text
  const marker = "\n[Message clipped for summarization.]"
  return text.slice(0, Math.max(0, cap * 4 - marker.length)) + marker
}

const hasSummary = (assembly: Assembly, piece: number): boolean =>
  assembly.pieces[piece]?.source.kind === "summary" ||
  (assembly.lcmFailurePieces?.some((failure) => failure.piece === piece) ?? false) ||
  (assembly.pieces[piece]?.parts?.some((p) => hasSummary(assembly, p)) ?? false)

const presetSource = (assembly: Assembly, identifier: string): Source => {
  const preset = need(assembly, "preset")
  return { kind: "preset", ref: preset.ref, revision: preset.revision, identifier }
}

const cardSource = (card: CardInput, field: string): Source => ({
  kind: "card",
  entity: card.entity,
  revision: card.revision,
  field
})

const recorded = (entry: HistoryEntry, cast: Cast) =>
  entry.speaker === null ? undefined : [...cast.characters, ...cast.personas].find((c) => c.entity === entry.speaker)

/** The user's side or the model's: a card the user plays speaks on the user's side. */
const sideOf = (entry: HistoryEntry, cast: Cast) => {
  const card = recorded(entry, cast)
  return card ? (cast.personas.includes(card) ? "user" : "assistant") : entry.side
}

/** The card a message belongs to: its recorded speaker, else the first of its side. */
const speakerOf = (entry: HistoryEntry, cast: Cast): CardInput | undefined =>
  recorded(entry, cast) ?? (entry.side === "user" ? cast.personas[0] : cast.characters[0])

const pathStage: AssemblerStage = {
  id: "path",
  run: (assembly) =>
    Effect.gen(function* () {
      const sources = yield* AssemblySources
      assembly.target = yield* sources.target
      return assembly
    })
}

const stateStage: AssemblerStage = {
  id: "state",
  run: (assembly) =>
    Effect.gen(function* () {
      const sources = yield* AssemblySources
      const events = yield* sources.events(need(assembly, "target").parentSlotId)
      assembly.events = events
      assembly.state = foldState(events.map((e) => e.event))
      return assembly
    })
}

/** The cast a state names, its cards through their layers; `speaker` speaks, when it's known. */
const castOf = (state: ChatState, speakerId: string | null, ordinal: number) =>
  Effect.gen(function* () {
    const sources = yield* AssemblySources
    const played = new Set(state.playedByMe)
    const wanted = [...new Set([...state.participants, ...state.playedByMe, ...(speakerId ? [speakerId] : [])])]
    const cards = new Map((yield* sources.cards(wanted, state.cardBindings)).map((c) => [c.entity, c]))
    const characters = wanted.filter((e) => !played.has(e)).flatMap((e) => cards.get(e) ?? [])
    const personas = state.playedByMe.flatMap((e) => cards.get(e) ?? [])
    const absent = new Set(state.absent)
    const speaker =
      (speakerId ? cards.get(speakerId) : undefined) ??
      characters.find((c) => !absent.has(c.entity)) ??
      characters[0] ??
      null
    const type: GenerationType =
      speaker && played.has(speaker.entity) ? "impersonate" : ordinal > 0 ? "swipe" : "normal"
    const cast: Cast = { characters, personas, absent, speaker, type }
    return cast
  })

const castStage: AssemblerStage = {
  id: "cast",
  run: (assembly) =>
    Effect.gen(function* () {
      const target = need(assembly, "target")
      assembly.cast = yield* castOf(need(assembly, "state"), target.speaker, target.ordinal)
      if (assembly.request.summarizing) assembly.cast = { ...assembly.cast, type: "quiet" }
      // ST's Continue: its own generation type, which a preset prompt's trigger can name.
      else if (target.continues) assembly.cast = { ...assembly.cast, type: "continue" }
      return assembly
    })
}

const modelStage: AssemblerStage = {
  id: "model",
  run: (assembly) =>
    Effect.gen(function* () {
      const sources = yield* AssemblySources
      const bindings = need(assembly, "state").modelBindings
      assembly.model = yield* sources.model(
        (assembly.request.summarizing ? bindings["summarizer"] : undefined) ??
          bindings["narrator"] ??
          bindings[""] ??
          null
      )
      return assembly
    })
}

const presetStage: AssemblerStage = {
  id: "preset",
  run: (assembly) =>
    Effect.gen(function* () {
      const sources = yield* AssemblySources
      const bindings = need(assembly, "state").presetBindings
      assembly.preset = yield* sources.preset({
        role: (assembly.request.summarizing ? bindings["summarizer"] : undefined) ?? bindings["narrator"] ?? null,
        chat: bindings[""] ?? null,
        connection: assembly.model?.presetOverride ?? null
      })
      return assembly
    })
}

/** Whether each note the events turned on or off is on, as they last left it. */
const switchesOf = (events: ReadonlyArray<PositionedEvent>) => noteSwitches(events.map((e) => e.event))

/**
 * The notes that are on (DESIGN §4.1): a card's first note is ST's Character's Note, which
 * ST always sends, so it's on unless the chat turned it off; any other note, the chat's own
 * included, is on once the chat turns it on (`note.activate`).
 */
const activeNotes = (events: ReadonlyArray<PositionedEvent>, notes: ReadonlyArray<NoteInput>) => {
  const last = switchesOf(events)
  return notes.filter((note) => last.get(note.entity) ?? note.first)
}

/** The chat's author's note, whose place ST's persona descriptions and lore at its top or bottom ride on. */
const isAuthorNote = (state: ChatState, note: NoteInput) =>
  note.doc.kind === "author_note" || note.entity === state.authorNote

/**
 * Whether a note with an interval goes this turn, as ST's author's note does
 * (setFloatingPrompt): every `interval` messages of the user's, counted over the whole path;
 * an interval of 1 always, 0 never, and none (a note without one) always.
 */
const due = (interval: number | undefined, userMessages: number) =>
  interval === undefined ||
  interval === 1 ||
  (interval > 1 && userMessages >= interval && userMessages % interval === 0)

/**
 * An imported summary as ST would send it on this path: the newest of its texts saved on a
 * message of the path, up to the leaf (DATA-MODEL §15, invariant 5); none when the path has
 * none of them. A text with no message (one the user wrote) applies anywhere. The
 * template and placement are the current revision's, which alone keeps them.
 */
const summaryOnPath = (notes: ReadonlyArray<NoteInput>, target: Target) =>
  Effect.gen(function* () {
    const sources = yield* AssemblySources
    const leaf = target.parentSlotId
    const placed = yield* Effect.forEach(notes, (note) =>
      Effect.gen(function* () {
        if (note.doc.kind !== "imported_summary" || note.doc.source_slot_id === undefined) return [note]
        const history = yield* sources.noteHistory(note.entity, note.revision, SUMMARY_HISTORY)
        const saved = [...new Set(history.flatMap((r) => (r.doc.source_slot_id ? [r.doc.source_slot_id] : [])))]
        const onPath = yield* sources.onPath(leaf, saved)
        const found = selectSummary(note.doc, history, onPath)
        return found ? [{ ...note, ...found }] : []
      })
    )
    return placed.flat()
  })

const notesStage: AssemblerStage = {
  id: "notes",
  run: (assembly) =>
    Effect.gen(function* () {
      const sources = yield* AssemblySources
      const state = need(assembly, "state")
      const cast = need(assembly, "cast")
      const target = need(assembly, "target")
      // ST has one persona; its note is the one that matters in its mode.
      const personas = modeOf(state, cast).st ? cast.personas.slice(0, 1) : cast.personas
      const notes = yield* sources.notes(
        [...cast.characters, ...personas].map((c) => c.entity),
        state.noteRevisions
      )
      const active = yield* summaryOnPath(activeNotes(need(assembly, "events"), notes), target)
      assembly.placedPersonas = new Set(
        notes.flatMap((note) => {
          const card = noteCard(note.doc)
          return card !== null && placesDescription(note) && personas.some((p) => p.entity === card) ? [card] : []
        })
      )
      // Interval zero remains off even when activated, rather than becoming a missing note after gating.
      assembly.authorNoteOff = notes.some(
        (note) => isAuthorNote(state, note) && (!active.includes(note) || note.doc.interval === 0)
      )
      // The path is counted only for an interval that needs it: it's a walk to the root.
      const userMessages = active.some((note) => (note.doc.interval ?? 0) > 1)
        ? yield* sources.userMessages(
            target.parentSlotId,
            cast.personas.map((c) => c.entity),
            cast.characters.map((c) => c.entity)
          )
        : 0
      assembly.notes = active
      assembly.noteUserMessages = userMessages
      return assembly
    })
}

/** Gate after the history's roles exist, before any note can change its last role. */
const noteGateStage = sync("note-gate", (assembly) => {
  const fill =
    need(assembly, "projected").at(-1)?.role === "assistant" &&
    need(assembly, "preset").doc.utility_prompts.send_if_empty !== ""
  assembly.sendIfEmpty = fill
  const count = need(assembly, "noteUserMessages") + (fill && need(assembly, "cast").type === "normal" ? 1 : 0)
  const active = need(assembly, "notes")
  const switches = switchesOf(need(assembly, "events"))
  assembly.noteDecisions = new Map(
    active.map((note) => [
      note.entity,
      {
        kind: "note" as const,
        activation: switches.get(note.entity) === true ? ("explicit" as const) : ("default" as const),
        interval: note.doc.interval ?? null,
        userMessages: (note.doc.interval ?? 0) > 1 ? count : null,
        due: due(note.doc.interval, count)
      }
    ])
  )
  assembly.skippedNotes = active.filter((note) => !due(note.doc.interval, count) && (note.doc.interval ?? 0) > 1)
  assembly.notes = active.filter((note) => due(note.doc.interval, count))
})

const modeOf = (state: ChatState, cast: Cast): Mode => {
  const layout = state.layoutCards
  const projection = state.rolesProjection
  return {
    st: cast.characters.length === 1 && layout === null && (projection === null || projection === "by_writer"),
    layout: layout ?? "concat",
    projection: projection ?? "by_writer"
  }
}

const modeStage = sync("mode", (assembly) => {
  assembly.mode = modeOf(need(assembly, "state"), need(assembly, "cast"))
})

/** The bindings macros see (DESIGN §5.3): ST's names for one character, the cast's otherwise. */
const namesFor = (state: ChatState, cast: Cast, mode: Mode): Names => {
  const pinned = state.macroBindings
  const join = (cards: ReadonlyArray<CardInput>) => cards.map((c) => c.doc.name).join(", ")
  if (mode.st) {
    return {
      user: pinned["user"] ?? cast.personas[0]?.doc.name ?? "User",
      char: pinned["char"] ?? cast.characters[0]!.doc.name
    }
  }
  const everyone = [...cast.characters, ...cast.personas]
  return {
    user: pinned["user"] ?? (join(cast.personas) || "User"),
    char: pinned["char"] ?? join(cast.characters),
    group: join(cast.characters),
    groupNotMuted: join(cast.characters.filter((c) => !cast.absent.has(c.entity))),
    notChar: join(everyone.filter((c) => c.entity !== cast.speaker?.entity))
  }
}

/**
 * Macro expansion by source (DESIGN §5.6): sets up the expander the later stages use for
 * preset and card text. The path's messages come in once they're read (`resolve`).
 */
/**
 * The card fields preset text reads: ST's character, or the first of the cast, which stays the
 * same from turn to turn, with its first note as ST's Character's Note.
 */
const macroCard = (cast: Cast, notes: ReadonlyArray<NoteInput> | undefined) => {
  const card = cast.characters[0]
  const firstNote = notes?.find((n) => n.first && noteCard(n.doc) === card?.entity)
  return cardFields(card, cast.personas[0], firstNote?.doc.content)
}

const macrosStage = sync("macros", (assembly) => {
  const cast = need(assembly, "cast")
  const preset = need(assembly, "preset").doc
  assembly.macros = makeMacroEnvironment(assembly, {
    names: namesFor(need(assembly, "state"), cast, need(assembly, "mode")),
    card: macroCard(cast, assembly.notes),
    messages: [],
    model: assembly.model?.key ?? "",
    maxContextTokens: preset.samplers.openai_max_context,
    maxResponseTokens: preset.samplers.openai_max_tokens,
    type: cast.type,
    chatId: need(assembly, "target").chatId,
    variables: need(assembly, "state").vars,
    summary: assembly.lcm?.summaries.length
      ? layerText(assembly.lcm.summaries, need(assembly, "mode").st)
      : (summaryNote(assembly)?.doc.content ?? "")
  })
})

const scriptsStage = sync("scripts", (assembly) => {
  assembly.scripts = promptScripts(assembly)
})

const placementOf = (entry: HistoryEntry, cast: Cast) =>
  sideOf(entry, cast) === "user" ? PLACEMENT.userInput : PLACEMENT.aiOutput

/**
 * The path, newest first, as far back as the budget could use: whole windows are read
 * until the text read, as the regex scripts leave it, would fill the budget on its own.
 * The budget then decides exactly which messages go (`compose`).
 */
const historyStage: AssemblerStage = {
  id: "history",
  run: (assembly) =>
    Effect.gen(function* () {
      const sources = yield* AssemblySources
      const target = need(assembly, "target")
      const cast = need(assembly, "cast")
      const runner = need(assembly, "scripts")
      assembly.previousHistoryStart = yield* sources.historyStart(target.parentSlotId)
      assembly.historyRevision = yield* sources.historyRevision(
        target.parentSlotId,
        assembly.previousHistoryStart?.depth ?? 0
      )
      const budget = contextBudget(assembly)
      const scripted = new Map<string, Scripted>()
      let entries: ReadonlyArray<HistoryEntry> = []
      let leaf = target.parentSlotId
      let tokens = 0
      let depth = 0
      while (
        leaf !== null &&
        leaf !== assembly.lcm?.cursor &&
        (tokens < budget || depth < (assembly.loreScanDepth ?? 0))
      ) {
        const window = yield* sources.history(leaf, HISTORY_WINDOW, assembly.lcm?.cursor ?? undefined)
        entries = [...window.entries, ...entries]
        // A template's stored text isn't what it expands to, which may be nothing: it counts as
        // nothing here, so it never ends the read early.
        const verbatim: Array<{ readonly entry: HistoryEntry; readonly depth: number }> = []
        for (const entry of [...window.entries].reverse()) {
          if (!entry.inContext) continue
          if (entry.macroMode === "verbatim") verbatim.push({ entry, depth })
          depth++
        }
        const results = applyScripts(
          assembly,
          runner,
          verbatim.map(({ entry, depth }) => ({ text: entry.content, placement: placementOf(entry, cast), depth }))
        )
        verbatim.forEach(({ entry, depth }, i) => {
          const result = { ...results[i]!, text: clipForSummary(assembly, results[i]!.text) }
          scripted.set(entry.versionId, { ...result, depth })
          tokens += tokensOf({ content: result.text })
        })
        leaf = window.older
      }
      assembly.history = entries
      assembly.historyOmitted =
        leaf === null ? 0 : Math.max(0, (entries[0]?.depth ?? target.depth) - (assembly.lcm?.cursorDepth ?? -1) - 1)
      assembly.scripted = scripted
      return assembly
    })
}

/** Lore scanning sees the prompt-side templates too; composition reuses these results. */
const loreScanStage = sync("lore-scan", (assembly) => {
  if (!need(assembly, "lorebooks").length) return
  const projected = need(assembly, "projected")
  const scripted = new Map(need(assembly, "scripted"))
  const rest = projected.flatMap((p, i) =>
    scripted.get(p.entry.versionId)?.depth === projected.length - 1 - i ? [] : [i]
  )
  const results = applyScripts(
    assembly,
    need(assembly, "scripts"),
    rest.map((i) => ({
      text: need(assembly, "macros").text(projected[i]!.piece),
      placement: placementOf(projected[i]!.entry, need(assembly, "cast")),
      depth: projected.length - 1 - i
    }))
  )
  rest.forEach((index, i) =>
    scripted.set(projected[index]!.entry.versionId, { ...results[i]!, depth: projected.length - 1 - index })
  )
  assembly.scripted = scripted
})

/** Where a template message is: the cast, names and card its macros saw there. */
interface Position {
  readonly cast: Cast
  readonly names: Names
  readonly card: CardFields
}

/** What decides a position's cast, names and card: equal keys share them. */
const positionKey = (state: ChatState, events: ReadonlyArray<PositionedEvent>) =>
  JSON.stringify([
    state.participants,
    state.playedByMe,
    state.absent,
    state.cardBindings,
    state.macroBindings,
    state.layoutCards,
    state.rolesProjection,
    state.noteRevisions,
    [...switchesOf(events)]
  ])

const positionOf = (state: ChatState, events: ReadonlyArray<PositionedEvent>) =>
  Effect.gen(function* () {
    const sources = yield* AssemblySources
    const cast = yield* castOf(state, null, 0)
    const card = cast.characters[0]
    const notes = card ? activeNotes(events, yield* sources.notes([card.entity], state.noteRevisions)) : []
    const position: Position = { cast, names: namesFor(state, cast, modeOf(state, cast)), card: macroCard(cast, notes) }
    return position
  })

/**
 * The path's messages, verbatim unless they're templates, which expand with the chat as it
 * was at their position and, the first time, hand back their writes (§15 "Macros by source").
 */
const resolveStage: AssemblerStage = {
  id: "resolve",
  run: (assembly) =>
    Effect.gen(function* () {
      const cast = need(assembly, "cast")
      const env = need(assembly, "macros")
      const events = need(assembly, "events")
      const positions = new Map<string, Position>([
        [
          positionKey(need(assembly, "state"), events),
          { cast, names: env.names, card: macroCard(cast, assembly.notes) }
        ]
      ])
      // Older messages that weren't read still count for the macros that number messages.
      const omitted: ChatMessage = { text: "", fromUser: false, system: true }
      const messages: Array<ChatMessage> = Array.from({ length: assembly.historyOmitted ?? 0 }, () => omitted)
      const resolved: Array<{ entry: HistoryEntry; piece: number }> = []
      // Writes of templates not expanded before, as events at their positions.
      const written: Array<PositionedEvent> = []
      const withWritten = () =>
        written.length === 0 ? events : [...events, ...written].sort((a, b) => (a.depth ?? -1) - (b.depth ?? -1))
      for (const entry of need(assembly, "history")) {
        if (!entry.inContext) {
          messages.push(omitted)
          continue
        }
        let at: MessagePosition | undefined
        if (entry.macroMode === "template") {
          const before = withWritten().filter((e) => e.depth === null || e.depth < entry.depth)
          const state = foldState(before.map((e) => e.event))
          const key = positionKey(state, before)
          const position = positions.get(key) ?? (yield* positionOf(state, before))
          positions.set(key, position)
          const speaker = speakerOf(entry, position.cast)
          const own = speaker && !position.cast.personas.includes(speaker) ? { char: speaker.doc.name } : {}
          at = {
            names: { ...position.names, ...own },
            card: position.card,
            variables: state.vars,
            ...(entry.macroMode === "template" && !entry.written
              ? {
                  writes: (effects: ReadonlyArray<VariableEffect>) => {
                    if (effects.length === 0) return
                    assembly.templateWrites.push({ version: entry.versionId, writes: effects })
                    for (const { name, value } of effects) {
                      written.push({
                        depth: entry.depth,
                        event: { scope: null, data: { key: "var.set", value: { name, value } } }
                      })
                    }
                  }
                }
              : {})
          }
        }
        const piece = env.message(entry, messages, at)
        resolved.push({ entry, piece })
        messages.push({
          text: env.text(piece),
          fromUser: sideOf(entry, cast) === "user",
          sentAt: entry.sentAt,
          versions: entry.versions,
          selectedVersion: entry.selectedOrdinal
        })
      }
      env.setMessages(messages)
      if (written.length > 0) env.rebase(foldState(withWritten().map((e) => e.event)).vars)
      assembly.resolved = resolved
      return assembly
    })
}

/**
 * Role projection (DESIGN §5.4): by writer (ST's: the user's side is `user`), strict
 * alternation by position (even depths, the greeting's, are `assistant`), or by
 * perspective (the speaker's own turns are `assistant`).
 */
const rolesStage = sync("roles", (assembly) => {
  const cast = need(assembly, "cast")
  const { projection } = need(assembly, "mode")
  const names = need(assembly, "macros").names
  assembly.projected = need(assembly, "resolved").map(({ entry, piece }): ProjectedEntry => {
    const speaker = speakerOf(entry, cast)
    const side = sideOf(entry, cast)
    const persona = speaker ? cast.personas.includes(speaker) : side === "user"
    const role =
      projection === "alternate"
        ? entry.depth % 2 === 0
          ? "assistant"
          : "user"
        : projection === "perspective"
          ? speaker !== undefined && speaker === cast.speaker
            ? "assistant"
            : "user"
          : side
    return { entry, role, name: speaker?.doc.name ?? (persona ? names.user : names.char), persona, piece }
  })
})

/** A card field as ST's baseChatReplace gives it: trimmed, expanded without card fields, no carriage returns. */
const cardText = (assembly: Assembly, card: CardInput, field: keyof CardInput["doc"], names?: Partial<Names>): Text => {
  const env = need(assembly, "macros")
  const raw = String(card.doc[field] ?? "")
    .trim()
    .replace(/\r/g, "")
  const piece = env.piece(`card:${card.entity}:${String(field)}`, cardSource(card, String(field)), raw, {
    withoutCard: true,
    ...(names ? { names } : {})
  })
  return { text: env.text(piece), piece }
}

const presetText = (assembly: Assembly, id: string, text: string, names: Partial<Names> = {}): Text => {
  const env = need(assembly, "macros")
  const piece = env.piece(`preset:${id}`, presetSource(assembly, id), text, { names })
  const expanded = env.text(piece)
  if (
    assembly.lcm?.summaries.length &&
    /\{\{\s*summary\s*\}\}/i.test(text) &&
    expanded.includes(layerText(assembly.lcm.summaries, need(assembly, "mode").st))
  )
    assembly.pieces[piece] = { ...assembly.pieces[piece]!, parts: assembly.lcmPieces ?? [] }
  return { text: expanded, piece, volatile: env.isVolatile(piece) }
}

/**
 * The prompt collection, as ST's PromptManager builds it: the order's enabled prompts that
 * trigger for this generation type, prepared (macros expanded); a disabled `main` stays as
 * an empty prompt.
 */
const collectionOf = (assembly: Assembly): Array<StPrompt> => {
  const doc = need(assembly, "preset").doc
  const type = need(assembly, "cast").type
  const prompts = new Map(doc.prompts.map((p) => [p.identifier, p]))
  const collection: Array<StPrompt> = []
  for (const entry of doc.order) {
    const prompt = prompts.get(entry.identifier)
    if (!prompt) continue
    const allowed = entry.enabled && triggers(prompt, type)
    if (!allowed && entry.identifier !== "main") continue
    const text = allowed && prompt.content ? presetText(assembly, prompt.identifier, prompt.content) : null
    collection.push({
      identifier: prompt.identifier,
      role: text && !need(assembly, "mode").st && hasSummary(assembly, text.piece) ? "system" : prompt.role,
      ...(text && hasSummary(assembly, text.piece) ? { kind: "summary" as const } : {}),
      content: text?.text ?? "",
      piece: text?.piece ?? null,
      system_prompt: prompt.system_prompt,
      injection_position: prompt.injection_position,
      injection_depth: prompt.injection_depth,
      injection_order: prompt.injection_order,
      forbid_overrides: prompt.forbid_overrides
    })
  }
  return collection
}

/** Puts a prompt where its marker is, or at the end when the order has none (preparePromptsForChatCompletion). */
const place = (collection: Array<StPrompt>, identifier: string, role: Role, text: Text | null) => {
  const at = collection.findIndex((p) => p.identifier === identifier)
  const prompt = merged(at === -1 ? undefined : collection[at], identifier, role, text)
  if (at === -1) collection.push(prompt)
  else collection[at] = prompt
}

/**
 * A card's prompt override replaces a preset prompt unless the preset forbids it or turned it
 * off. ST expands the override with the card's other fields, before the preset's prompts,
 * and fills `{{original}}` (the prompt it replaces) once the prompt is known: the first
 * `{{original}}` becomes it and any other nothing, as ST's macro does.
 */
const override = (
  assembly: Assembly,
  collection: Array<StPrompt>,
  disabled: (identifier: string) => boolean,
  identifier: "main" | "jailbreak",
  text: Text
) => {
  const at = collection.findIndex((p) => p.identifier === identifier)
  if (at === -1 || !text.text || collection[at]!.forbid_overrides || disabled(identifier)) return
  const original = collection[at]!
  let first = true
  const content = text.text.replace(/\{\{original\}\}/gi, () => {
    if (!first) return ""
    first = false
    return original.content
  })
  const record = assembly.pieces[text.piece]!
  assembly.pieces[text.piece] = {
    ...record,
    text: content,
    parts: first || original.piece === null ? [] : [original.piece]
  }
  collection[at] = {
    ...original,
    content,
    piece: text.piece,
    kind: hasSummary(assembly, text.piece) ? "summary" : "prefix"
  }
}

/**
 * The preset's assistant prefill (impersonation prefill when the user's character speaks):
 * sent where the model can be prefilled, and otherwise dropped and reported (DESIGN §1.2).
 */
const prefill = (assembly: Assembly) => {
  if (assembly.request.summarizing) return
  const continues = need(assembly, "target").continues
  if (continues) return continuePrefill(assembly, continues.text)
  const doc = need(assembly, "preset").doc
  const type = need(assembly, "cast").type
  const raw = type === "impersonate" ? doc.prefill.impersonation : doc.prefill.assistant
  const id = type === "impersonate" ? "prefill.impersonation" : "prefill.assistant"
  const text = raw ? presetText(assembly, id, raw).text.trimEnd() : ""
  if (!text) return
  if (assembly.model && assembly.model.prefill !== "none" && !assembly.model.continueUnavailable) {
    assembly.prefill = text
  } else {
    assembly.issues.push({
      kind: "prefill_dropped",
      message: assembly.model
        ? `The preset's prefill wasn't sent: ${assembly.model.key} isn't known to take one. Set its prefill capability if it does.`
        : "The preset's prefill wasn't sent: no model is chosen."
    })
  }
}

/**
 * Continue sends the text it continues as the start of the reply, in place of the preset's
 * prefill (ST's "continue prefill"), so the model writes on from its end. Without a model
 * that takes one it can't continue: the version fails and says so (DESIGN §7.5). Trailing
 * whitespace goes, which Anthropic refuses at the end of a prefill.
 */
const continuePrefill = (assembly: Assembly, text: string) => {
  const model = assembly.model
  if (!model) {
    throw new AssemblyFailed({ reason: "no_model", message: "Continue needs a model: none is chosen." })
  }
  if (model.prefill === "none" || model.continueUnavailable) {
    throw new AssemblyFailed({
      reason: "no_prefill",
      message: `Continue isn't available with ${model.key}: ${model.continueUnavailable ?? "no prefill support is declared. Set its Prefill capability in Connections if supported."}`
    })
  }
  assembly.prefill = model.prefill === "tool_schema" ? text : text.trimEnd()
}

/** A message of the path as ST sends it, with the preset's names behavior (setOpenAIMessages). */
const chatLine = (
  assembly: Assembly,
  projected: ProjectedEntry,
  groupNames: boolean,
  scripted: { readonly text: string; readonly volatile: boolean }
): ChatLine => {
  const behavior = need(assembly, "preset").doc.names_behavior
  const text = scripted.text.replace(/\r/gm, "")
  const pieces = [projected.piece]
  const named = (prefix: boolean): ChatLine => ({
    role: projected.role,
    content: prefix ? `${projected.name}: ${text}` : text,
    pieces,
    // A depth-bounded regex script changes it as the chat grows: it isn't part of the stable prefix.
    kind: scripted.volatile ? "volatile" : "history"
  })
  switch (behavior) {
    case "content":
      return named(true)
    case "completion":
      return { ...named(false), name: sanitizeName(projected.name) }
    case "default":
      return named(groupNames && !projected.persona)
    case "none":
      return named(false)
  }
}

/** One context's time for the preset's regex scripts: V8 stops them once it's spent. */
const REGEX_MS = 200
/** Characters of text the scripts may make for one context, copied or replaced. */
const REGEX_OUTPUT = 8_000_000
/** Patterns longer than this, after the case rewrite, are left out. */
const MAX_PATTERN = 2_000
/** Scripts after this many are left out. */
const MAX_SCRIPTS = 100

/**
 * The preset's prompt-only regex scripts, once the user approved them (ARCHITECTURE §9):
 * the pattern compiled, with its macros expanded when the script asks for that, and the
 * replacement and trim strings expanded. A script that can't run safely is left out and reported.
 */
const promptScripts = (assembly: Assembly): ScriptRunner => {
  const doc = need(assembly, "preset").doc
  const limits = { ms: REGEX_MS, output: REGEX_OUTPUT }
  if (!doc.regex_approved) return makeScriptRunner([], limits)
  const usable = doc.regex.filter((script) => !script.disabled && script.prompt_only && script.find_regex)
  if (usable.length > MAX_SCRIPTS) {
    assembly.issues.push({
      kind: "regex_skipped",
      message: `Only the first ${MAX_SCRIPTS} of the preset's ${usable.length} prompt regex scripts run.`
    })
  }
  const list = usable.slice(0, MAX_SCRIPTS).flatMap((script): Array<PromptScript> => {
    const skip = (why: string) => {
      assembly.issues.push({
        kind: "regex_skipped",
        message: `The regex script "${script.name}" was left out: ${why}.`
      })
      return []
    }
    if (script.substitute_regex === "escaped") return skip("macros escaped into its pattern aren't supported")
    const find =
      script.substitute_regex === "raw"
        ? presetText(assembly, `regex:${script.id}:find`, script.find_regex).text
        : script.find_regex
    const regex = compile(find)
    if (regex === "unsafe") {
      return skip(
        "it needs backtracking (backreferences, lookaheads, nested counted repeats or Unicode properties), which could stall the server"
      )
    }
    if (regex === null) return skip("its pattern isn't a valid regular expression")
    if (regex.source.length > MAX_PATTERN) return skip("its pattern is too long")
    const replacement = script.replace_string
      ? presetText(assembly, `regex:${script.id}:replace`, script.replace_string).text
      : ""
    const trim = script.trim_strings.map((t, i) => presetText(assembly, `regex:${script.id}:trim:${i}`, t).text)
    return [{ script, regex, replacement, trim }]
  })
  return makeScriptRunner(list, limits)
}

/** The scripts' text for these messages, as one batch; what stopped them is reported once. */
const applyScripts = (
  assembly: Assembly,
  runner: ScriptRunner,
  items: ReadonlyArray<{ readonly text: string; readonly placement: number; readonly depth: number }>
) => {
  const expired = runner.expired
  const { results, failed } = runner.apply(items)
  const report = (message: string) => {
    if (!assembly.issues.some((i) => i.message === message)) assembly.issues.push({ kind: "regex_skipped", message })
  }
  for (const [{ script }, why] of failed)
    report(`The regex script "${script.name}" was skipped where it failed: ${why}.`)
  if (!expired && runner.expired && runner.list.length > 0) {
    report(
      `The regex scripts ran out of time (${REGEX_MS} ms for one context): the rest of the messages are sent without them.`
    )
  }
  return results
}

/** The example dialogue of one card, block by block (setOpenAIMessageExamples). */
const exampleLines = (assembly: Assembly, card: CardInput, char: string, prefixNames: boolean) => {
  const names = need(assembly, "macros").names
  const examples = cardText(assembly, card, "mes_example", prefixNames ? { char } : undefined)
  return exampleBlocks(examples.text).map((block) =>
    parseExampleBlock(block, names.user, char, prefixNames).map((line): ChatLine => ({
      role: "system",
      content: line.content,
      name: line.name,
      pieces: [examples.piece],
      kind: "prefix"
    }))
  )
}

/** The chat's summary as ST's Summarize extension kept it, when the chat has it on (DESIGN §8.1). */
const summaryNote = (assembly: Assembly, notes = assembly.notes) =>
  notes?.findLast((note) => note.doc.kind === "imported_summary" && noteCard(note.doc) === null)

const noteSource = (assembly: Assembly, note: NoteInput): Source => ({
  kind: "note",
  entity: note.entity,
  revision: note.revision,
  activation: assembly.noteDecisions?.get(note.entity)
})

/**
 * The summary as the extension sends it (formatMemoryValue): its template with `{{summary}}`
 * replaced, or `Summary: ` before it without one, expanded.
 */
const summaryText = (assembly: Assembly, note: NoteInput): Text | null => {
  const content = note.doc.content.trim()
  if (!content) return null
  const { template } = note.doc
  const formatted = template ? template.replace(/\{\{summary\}\}/gi, () => content) : `Summary: ${content}`
  const env = need(assembly, "macros")
  const piece = env.piece(`note:${note.entity}`, noteSource(assembly, note), formatted)
  const text = env.text(piece).trim()
  return { text, piece }
}

/** A note's text, expanded: a card's with `{{char}}` bound to the card, the chat's with the chat's bindings. */
const noteText = (assembly: Assembly, note: NoteInput, owner: CardInput | null): Text | null => {
  const env = need(assembly, "macros")
  const piece = env.piece(
    `note:${note.entity}`,
    noteSource(assembly, note),
    note.doc.content.trim(),
    owner ? { withoutCard: true, names: { char: owner.doc.name } } : {}
  )
  const text = env.text(piece)
  return { text, piece }
}

/**
 * Where a note goes: in-chat at a depth with a role (a tail note at depth 0, DESIGN §4.1's
 * "tail/D0"), or beside the main prompt, before or after it. The other sections aren't
 * placed yet.
 */
type NotePlace =
  | { readonly at: "chat"; readonly depth: number; readonly role: Role }
  | { readonly at: "start" | "end"; readonly volatile: boolean; readonly role: Role }

const placeOf = (note: NoteInput): NotePlace | null => {
  const { placement } = note.doc
  switch (placement.mode) {
    case "depth":
      return { at: "chat", depth: placement.depth, role: placement.role }
    case "tail":
      return { at: "chat", depth: 0, role: placement.role }
    case "section":
      if (placement.section !== "before_main_prompt" && placement.section !== "after_main_prompt") return null
      return {
        at: placement.section === "before_main_prompt" ? "start" : "end",
        // A note that comes and goes with its interval changes the prefix it's in.
        volatile: (note.doc.interval ?? 0) > 1,
        role: placement.role ?? "system"
      }
    case "none":
      return null
  }
}

/** A note ready to be placed; `text` expands it when the composition reaches it. */
interface PendingNote {
  readonly place: NotePlace
  readonly id: string
  /** Where the note sorts among ST's extension prompts: the summary, the author's note, the others, cards', personas'. */
  readonly rank: number
  readonly baseline: number
  /** The author's note that goes this turn: what is placed at its top and bottom joins its text. */
  readonly author?: true
  readonly text: () => Text | null
}

/** What ST puts at the top or bottom of the author's note: personas outermost, then other notes, then lore. */
interface Attachments {
  readonly top: ReadonlyArray<() => Text | null>
  readonly bottom: ReadonlyArray<() => Text | null>
}

/**
 * Where the chat stands with the author's note, which ST's persona descriptions and lore
 * placed at its top or bottom ride on (`setFloatingPrompt`, `addPersonaDescriptionExtensionPrompt`):
 * it goes this turn (`due`); it doesn't, by its interval (`skipped`) or because it is
 * switched off (`off`), so nothing rides along; or the chat has none (`none`), which ST
 * treats as its default note, empty, in-chat at depth 4 as the system, every message.
 */
type AuthorState = "due" | "skipped" | "off" | "none"

/** The notes placed with a card's definition, at its top (`section: card`), expanded, in id order. */
const cardNotes = (assembly: Assembly, card: CardInput, owner: CardInput | null): ReadonlyArray<Text> =>
  need(assembly, "notes")
    .filter(
      (note) =>
        noteCard(note.doc) === card.entity &&
        note.doc.placement.mode === "section" &&
        note.doc.placement.section === "card"
    )
    .toSorted((a, b) => (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0))
    .flatMap((note) => {
      const text = noteText(assembly, note, owner)
      return text?.text ? [text] : []
    })

/** A card's marker text with the notes placed with its definition above it. */
const withCardNotes = (assembly: Assembly, card: CardInput, owner: CardInput | null, field: Text | null) => {
  const top = cardNotes(assembly, card, owner)
  if (top.length === 0) return field
  const parts = field ? [...top, field] : top
  const text = parts.map((part) => part.text).join("\n")
  return {
    text,
    piece: need(assembly, "macros").verbatim(
      `card-notes:${card.entity}`,
      { kind: "assembler", what: "card definition with notes" },
      text,
      parts.map((part) => part.piece)
    )
  }
}

/**
 * The notes this context sends, in ST's order for its extension prompts (`1_memory`,
 * `2_floating_prompt`, `DEPTH_PROMPT`, `PERSONA_DESCRIPTION`): the chat's summary, its
 * author's note, its other notes, then the notes of `cards` and of `personas`, each group by
 * id. Notes at one depth and role are joined in this order, and those beside the main prompt
 * go there in it. Notes at the author's note's top or bottom are returned apart, to join its
 * text.
 */
const placedNotes = (assembly: Assembly, cards: ReadonlyArray<CardInput>, personas: ReadonlyArray<CardInput>) => {
  const env = need(assembly, "macros")
  const state = need(assembly, "state")
  const hasLayer = (assembly.lcm?.summaries.length ?? 0) > 0
  const candidates = [...need(assembly, "notes"), ...(assembly.skippedNotes ?? [])].filter(
    (n) => !hasLayer || n.doc.kind !== "imported_summary"
  )
  const summary = summaryNote(assembly, candidates)
  const isPersona = (note: NoteInput) => personas.some((p) => p.entity === noteCard(note.doc))
  const rank = (note: NoteInput) =>
    note === summary ? 0 : isPersona(note) ? 4 : noteCard(note.doc) !== null ? 3 : isAuthorNote(state, note) ? 1 : 2
  const sorted = candidates
    .filter((note) => note.doc.kind !== "imported_summary" || note === summary)
    .toSorted((a, b) => rank(a) - rank(b) || (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0))
  const authorNote = sorted.find((note) => isAuthorNote(state, note))
  const authorState: AuthorState = authorNote
    ? assembly.skippedNotes?.includes(authorNote)
      ? "skipped"
      : "due"
    : assembly.authorNoteOff
      ? "off"
      : "none"
  // A persona's text keeps the page's bindings: `{{char}}` is the character, not the persona.
  const textOf = (note: NoteInput, owner: CardInput | null) => (): Text | null => {
    const skipped = assembly.skippedNotes?.includes(note)
    // Every intermittent note is a potential writer; never expand a skipped one to find out.
    if ((note.doc.interval ?? 0) > 1) env.potentialVariableWrite()
    return skipped
      ? { text: "", piece: env.verbatim(`note:${note.entity}`, noteSource(assembly, note), "") }
      : note === summary
        ? summaryText(assembly, note)
        : noteText(assembly, note, owner)
  }
  const ownerOf = (note: NoteInput) => {
    const card = noteCard(note.doc)
    return card === null ? null : (cards.find((c) => c.entity === card) ?? null)
  }
  const section = (note: NoteInput) => (note.doc.placement.mode === "section" ? note.doc.placement.section : null)
  const attached = (which: "author_note_top" | "author_note_bottom") =>
    authorState === "due" || authorState === "none"
      ? sorted.filter(
          (note) =>
            section(note) === which &&
            !assembly.skippedNotes?.includes(note) &&
            (isPersona(note) || ownerOf(note) !== null || noteCard(note.doc) === null)
        )
      : []
  const attachments: Attachments = {
    top: [
      ...attached("author_note_top").filter(isPersona),
      ...attached("author_note_top").filter((note) => !isPersona(note))
    ].map((note) => textOf(note, ownerOf(note))),
    bottom: [
      ...attached("author_note_bottom").filter((note) => !isPersona(note)),
      ...attached("author_note_bottom").filter(isPersona)
    ].map((note) => textOf(note, ownerOf(note)))
  }
  const placed: Array<PendingNote> = sorted.flatMap((note) => {
    const card = noteCard(note.doc)
    const owner = ownerOf(note)
    const place = placeOf(note)
    if (place === null || (card !== null && owner === null && !isPersona(note))) return []
    const skipped = assembly.skippedNotes?.includes(note)
    const content =
      note === summary
        ? note.doc.template
          ? note.doc.template.replace(/\{\{summary\}\}/gi, () => note.doc.content.trim())
          : `Summary: ${note.doc.content.trim()}`
        : note.doc.content.trim()
    return [
      {
        place,
        id: note.entity,
        rank: rank(note),
        baseline: skipped && !content.includes("{{") ? content.length : 0,
        ...(note === authorNote && authorState === "due" ? { author: true as const } : {}),
        text: textOf(note, owner)
      }
    ]
  })
  if (hasLayer && need(assembly, "mode").st) {
    const imported = summaryNote(assembly)
    const place = imported ? placeOf(imported) : { at: "end" as const, volatile: false, role: "system" as const }
    if (place)
      placed.unshift({
        place,
        id: "lcm:placement",
        rank: 0,
        baseline: 0,
        text: () => {
          const piece = env.piece(
            "lcm:placement",
            { kind: "assembler", what: "summary placement" },
            imported?.doc.template || "Summary: {{summary}}"
          )
          const text = env.text(piece)
          if (text.includes(layerText(assembly.lcm!.summaries, true)))
            assembly.pieces[piece] = { ...assembly.pieces[piece]!, parts: assembly.lcmPieces ?? [] }
          return { piece, text }
        }
      })
  }
  return { placed, attachments, authorState }
}

/** The context as ST's populateChatCompletion builds it, with our layouts' blocks and tail outside ST mode. */
const composeStage = sync("compose", (assembly) => {
  const doc = need(assembly, "preset").doc
  const cast = need(assembly, "cast")
  const mode = need(assembly, "mode")
  const env = need(assembly, "macros")
  const names = env.names
  const utility = doc.utility_prompts
  const disabled = disabledIn(doc)
  const optional = (id: string, text: string, options?: Partial<Names>) =>
    text ? presetText(assembly, id, text, options) : null
  const control: Array<StMessage> = []
  let markers: { description: Text | null; personality: Text | null; scenario: Text | null; persona: Text | null }
  let examples: Array<Array<ChatLine>>
  let pendingNotes: ReturnType<typeof placedNotes>
  let newChat: Text | null

  // ST's card overrides, expanded with the card's fields, ahead of everything else.
  const overrides =
    mode.st && cast.characters[0]
      ? {
          main: cardText(assembly, cast.characters[0], "system_prompt"),
          jailbreak: cardText(assembly, cast.characters[0], "post_history_instructions")
        }
      : null
  if (mode.st) {
    const char = cast.characters[0]!
    const persona = cast.personas[0]
    examples = exampleLines(assembly, char, names.char, false)
    const description = cardText(assembly, char, "description")
    const personality = cardText(assembly, char, "personality")
    const scenario = cardText(assembly, char, "scenario")
    // A field with a format is the format expanded, which reads the field: ST's
    // scenario_format and personality_format.
    const formatted = (field: Text, format: string, id: string) =>
      field.text && format ? presetText(assembly, id, format) : field.text ? field : null
    markers = {
      description: withCardNotes(assembly, char, char, description.text ? description : null),
      personality: formatted(personality, utility.personality_format, "utility.personality_format"),
      scenario: formatted(scenario, utility.scenario_format, "utility.scenario_format"),
      persona: persona
        ? withCardNotes(
            assembly,
            persona,
            null,
            persona.doc.description && !assembly.placedPersonas?.has(persona.entity)
              ? (() => {
                  const piece = env.piece(
                    `card:${persona.entity}:description`,
                    cardSource(persona, "description"),
                    persona.doc.description
                  )
                  return { text: env.text(piece), piece }
                })()
              : null
          )
        : null
    }
    pendingNotes = placedNotes(assembly, [char], persona ? [persona] : [])
    newChat = optional("utility.new_chat_prompt", utility.new_chat_prompt)
  } else {
    const blocks = (cards: ReadonlyArray<CardInput>, block: typeof cardBlock | typeof personaBlock, persona = false) =>
      cards.flatMap((card) => {
        const text = block(assembly, card, cardText, cardNotes(assembly, card, persona ? null : card))
        return text ? [text] : []
      })
    const characters = mode.layout === "swap_tail" ? [] : blocks(cast.characters, cardBlock)
    const joined = (id: string, texts: ReadonlyArray<Text>): Text | null => {
      if (texts.length === 0) return null
      const text = texts.map((t) => t.text).join("\n\n")
      const parts = texts.map((t) => t.piece)
      return { text, piece: env.verbatim(`layout:${id}`, { kind: "assembler", what: "labelled blocks" }, text, parts) }
    }
    markers = {
      description: joined("characters", characters),
      personality: null,
      scenario: null,
      persona: joined("personas", blocks(cast.personas, personaBlock, true))
    }
    const tailCards =
      mode.layout === "swap_tail" && cast.speaker && !cast.personas.includes(cast.speaker) ? [cast.speaker] : []
    examples = (mode.layout === "swap_tail" ? tailCards : cast.characters).flatMap((card) =>
      exampleLines(assembly, card, card.doc.name, true)
    )
    pendingNotes = placedNotes(assembly, mode.layout === "swap_tail" ? tailCards : cast.characters, cast.personas)
    newChat =
      cast.characters.length > 1
        ? optional("utility.new_group_chat_prompt", utility.new_group_chat_prompt)
        : optional("utility.new_chat_prompt", utility.new_chat_prompt)
    for (const card of tailCards) {
      const block = cardBlock(assembly, card, cardText, cardNotes(assembly, card, card))
      control.push({ role: "system", content: block.text, pieces: [block.piece], kind: "volatile" })
    }
    const said = assembly.request.summarizing ? "" : directive(assembly, presetText)
    if (said) control.push({ role: "system", content: said.text, pieces: [said.piece], kind: "volatile" })
  }

  const collection = collectionOf(assembly)
  const lore = assembly.lore ?? []
  const loreBlock = (id: string, entries: typeof lore, format = false): Text | null => {
    if (!entries.length) return null
    const parts = entries.map((e) => e.piece)
    let text = parts.map(env.text).filter(Boolean).join("\n")
    if (!text) return null
    if (format && utility.wi_format) {
      const wrapper = presetText(assembly, `utility.wi_format:${id}`, utility.wi_format)
      text = wrapper.text.replace(/\{0\}/g, () => text)
      parts.push(wrapper.piece)
    }
    return { text, piece: env.verbatim(`lore:block:${id}`, { kind: "assembler", what: "lorebook block" }, text, parts) }
  }
  const stLore = mode.st ? lore.toReversed() : []
  place(
    collection,
    "worldInfoBefore",
    "system",
    loreBlock(
      "before",
      stLore.filter((e) => e.entry.position === "before_char"),
      true
    )
  )
  place(
    collection,
    "worldInfoAfter",
    "system",
    loreBlock(
      "after",
      stLore.filter((e) => e.entry.position === "after_char"),
      true
    )
  )
  let loreCost = 0
  if (!mode.st) {
    const block = loreBlock("tail", lore)
    loreCost = tokensOf({ content: block?.text ?? "" })
    // Always reserve the volatility boundary, including when activation produced nothing.
    control.unshift({
      role: "system",
      content: block?.text ?? "",
      pieces: block ? [block.piece] : [],
      kind: "volatile"
    })
  }
  const loreExamples = (position: "em_top" | "em_bottom") =>
    (position === "em_top" ? stLore.toReversed() : stLore)
      .filter((e) => e.entry.position === position)
      .flatMap((e) =>
        exampleBlocks(env.text(e.piece)).map((block) =>
          parseExampleBlock(block, names.user, names.char, false).map((line): ChatLine => ({
            role: "system",
            content: line.content,
            name: line.name,
            pieces: [e.piece],
            kind: "volatile"
          }))
        )
      )
  examples = [...loreExamples("em_top"), ...examples, ...loreExamples("em_bottom")]
  for (const e of stLore.filter((e) => e.entry.position === "outlet"))
    assembly.issues.push({
      kind: "lorebook_issue",
      message: `Lorebook outlet ${e.entry.outlet_name} has no prompt outlet; entry ${e.entry.uid} was not placed.`
    })
  place(collection, "charDescription", "system", markers.description)
  place(collection, "charPersonality", "system", markers.personality)
  place(collection, "scenario", "system", markers.scenario)
  const impersonate =
    mode.st && cast.type === "impersonate"
      ? optional("utility.impersonation_prompt", utility.impersonation_prompt)
      : null
  place(collection, "impersonate", "system", impersonate)
  place(collection, "quietPrompt", "system", null)
  place(collection, "bias", "assistant", null)
  if (markers.persona) place(collection, "personaDescription", "system", markers.persona)
  if (mode.st) {
    override(assembly, collection, disabled, "main", overrides!.main)
    override(assembly, collection, disabled, "jailbreak", overrides!.jailbreak)
  }
  if (impersonate) {
    const prompt = collection.find((p) => p.identifier === "impersonate")!
    control.unshift({ role: prompt.role, content: prompt.content, pieces: [impersonate.piece], kind: "volatile" })
  }
  const direction = need(assembly, "target").direction
  if (direction && !assembly.request.summarizing) {
    const piece = env.verbatim(
      "direction",
      { kind: "direction", version: need(assembly, "target").versionId },
      direction
    )
    control.push({ role: "system", content: direction, pieces: [piece], kind: "volatile" })
  }

  const previous =
    assembly.previousHistoryStart && assembly.previousHistoryStart.depth <= need(assembly, "target").depth
      ? assembly.previousHistoryStart
      : null
  const configuration = createHash("sha256")
    .update(
      JSON.stringify([
        doc,
        assembly.model,
        mode,
        [...cast.characters, ...cast.personas].map((c) => [c.entity, c.doc]),
        [...(assembly.notes ?? []), ...(assembly.skippedNotes ?? [])].toSorted((a, b) =>
          a.entity.localeCompare(b.entity)
        ),
        assembly.lorebooks
      ])
    )
    .digest("hex")
  const identity = JSON.stringify([need(assembly, "preset").ref, assembly.model?.connectionId, assembly.model?.modelId])
  const prior = previous?.state
  const configurationChanged = prior?.configuration !== configuration

  // Placement order is independent of expansion order: summaries see main's writes.
  const authorBlock = (id: string, parts: ReadonlyArray<Text | null | undefined>, what: string): Text | null => {
    const present = parts.filter((part): part is Text => part !== null && part !== undefined)
    const combined = present
      .map((part) => part.text)
      .join("\n")
      .trim()
    return present.length === 0
      ? null
      : {
          text: combined,
          piece: env.verbatim(
            id,
            { kind: "assembler", what },
            combined,
            present.map((part) => part.piece)
          )
        }
  }
  const loreTop = () =>
    loreBlock(
      "an-top",
      stLore.filter((e) => e.entry.position === "an_top")
    )
  const loreBottom = () =>
    loreBlock(
      "an-bottom",
      stLore.filter((e) => e.entry.position === "an_bottom")
    )
  const { attachments, authorState } = pendingNotes
  // ST adds what rides on the author's note to its text, persona outermost: the lore first
  // (`getWorldInfoPrompt`), then the persona (`addPersonaDescriptionExtensionPrompt`).
  const around = (expanded: Text): Text => {
    const top = [...attachments.top.map((attach) => attach()), loreTop()]
    const bottom = [loreBottom(), ...attachments.bottom.map((attach) => attach())]
    return [...top, ...bottom].some((part) => part !== null)
      ? authorBlock("lore:author-note", [...top, expanded, ...bottom], "author's note with lore and personas")!
      : expanded
  }
  const notes = pendingNotes.placed.flatMap(({ text, place, id, baseline, rank, author }) => {
    const expanded = text()
    if (!expanded) return []
    return [{ text: author ? around(expanded) : expanded, place, id, baseline, rank }]
  })
  // A chat without an author's note has ST's default one: empty, in-chat at depth 4 as the
  // system, every message. What rides on it (a persona at its top or bottom, lore) is still sent.
  if (authorState === "none") {
    // The empty note still takes its line between what rides on it, as in ST's join.
    const empty = {
      text: "",
      piece: env.verbatim("author-note:default", { kind: "assembler", what: "default author's note" }, "")
    }
    const combined = around(empty)
    if (combined && combined !== empty) {
      const at = notes.findIndex((note) => note.rank > 1)
      notes.splice(at < 0 ? notes.length : at, 0, {
        text: combined,
        place: { at: "chat", depth: 4, role: "system" },
        id: "author-note:default",
        baseline: 0,
        rank: 1
      })
    }
  }
  const sendIfEmpty = assembly.sendIfEmpty ? optional("utility.send_if_empty", utility.send_if_empty) : null
  const normalFill =
    cast.type === "normal" && sendIfEmpty?.text
      ? {
          role: "user" as const,
          content: doc.names_behavior === "content" ? `${names.user}: ${sendIfEmpty.text}` : sendIfEmpty.text,
          ...(doc.names_behavior === "completion" ? { name: sanitizeName(names.user) } : {}),
          pieces: [sendIfEmpty.piece],
          kind: "volatile" as const
        }
      : null
  const groupNames = !mode.st
  const projected = need(assembly, "projected")
  // The history stage ran the scripts on the verbatim messages it read; templates run here.
  const read = need(assembly, "scripted")
  const scripted: Array<{ readonly text: string; readonly volatile: boolean } | undefined> = projected.map((p, i) =>
    read.get(p.entry.versionId)?.depth === projected.length - 1 - i ? read.get(p.entry.versionId) : undefined
  )
  const rest = scripted.flatMap((s, i) => (s ? [] : [i]))
  const ran = applyScripts(
    assembly,
    need(assembly, "scripts"),
    rest.map((i) => ({
      text: env.text(projected[i]!.piece),
      placement: placementOf(projected[i]!.entry, cast),
      depth: projected.length - 1 - i
    }))
  )
  rest.forEach((index, i) => (scripted[index] = { ...ran[i]!, text: clipForSummary(assembly, ran[i]!.text) }))
  // Notes in-chat are extension prompts at their depth; the others go beside the main prompt,
  // one after another (injectToMain).
  // Lore above history can change per turn, even when this turn has no activated entry.
  if (
    mode.st &&
    need(assembly, "lorebooks").some((b) =>
      b.doc.entries.some(
        (e) =>
          e.enabled && ["before_char", "after_char", "em_top", "em_bottom", "an_top", "an_bottom"].includes(e.position)
      )
    )
  ) {
    const prompt = collection[0]
    if (prompt)
      collection.splice(collection.indexOf(prompt), 0, {
        ...prompt,
        identifier: "lore-cache-boundary",
        content: "",
        piece: null,
        system_prompt: false,
        injection_position: "relative",
        barrier: true
      })
  }
  const placement = (placed: typeof notes) => {
    const collection = [...baseCollection]
    const layer: Array<StMessage> = placed.flatMap(({ text, place }) =>
      place.at === "chat" && hasSummary(assembly, text.piece)
        ? [{ role: place.role, content: text.text, pieces: [text.piece], kind: "summary" as const }]
        : []
    )
    const injections: Array<Injection> = placed.flatMap(({ text, place }) =>
      place.at === "chat" && !hasSummary(assembly, text.piece) ? [{ depth: place.depth, role: place.role, text }] : []
    )
    for (const e of stLore.filter((e) => e.entry.position === "at_depth"))
      injections.push({
        depth: Math.max(0, Math.min(10000, e.entry.depth)),
        role: e.entry.role,
        text: { text: env.text(e.piece), piece: e.piece }
      })
    const beside: Array<{ readonly message: StMessage; readonly at: "start" | "end" }> = []
    for (const { text, place } of placed) {
      if (place.at === "chat") continue
      const main = collection.findIndex((p) => p.identifier === "main")
      const mainPrompt = collection[main]
      if (mainPrompt?.injection_position === "absolute") {
        // Main in-chat: the note is injected beside it, with its role, depth and order.
        collection.splice(place.at === "start" ? main : main + 1, 0, {
          ...mainPrompt,
          identifier: "note",
          role: place.role,
          content: text.text,
          piece: text.piece,
          system_prompt: undefined,
          forbid_overrides: false,
          barrier: (place.volatile || env.isVolatile(text.piece)) && !text.text
        })
      } else if (mainPrompt) {
        const kind = place.volatile ? "volatile" : "prefix"
        beside.push({ message: { role: place.role, content: text.text, pieces: [text.piece], kind }, at: place.at })
      }
    }
    for (let i = collection.length - 1; i >= 0; i--) {
      const prompt = collection[i]!
      if (prompt.piece === null || !hasSummary(assembly, prompt.piece) || disabled(prompt.identifier)) continue
      if (prompt.injection_position === "absolute") {
        layer.unshift({ role: prompt.role, content: prompt.content, pieces: [prompt.piece], kind: "summary" })
        collection.splice(i, 1)
      } else if (i > collection.findIndex((p) => p.identifier === "chatHistory")) {
        collection.splice(i, 1)
        collection.splice(
          Math.max(
            0,
            collection.findIndex((p) => p.identifier === "chatHistory")
          ),
          0,
          prompt
        )
      }
    }
    if (
      collection.findIndex((p) => p.identifier === "main") > collection.findIndex((p) => p.identifier === "chatHistory")
    ) {
      for (let i = beside.length - 1; i >= 0; i--) {
        const { message } = beside[i]!
        if (!message.pieces.some((p) => hasSummary(assembly, p))) continue
        layer.unshift({ ...message, kind: "summary" })
        beside.splice(i, 1)
      }
    }
    const hasSummaryPrompt = collection.some(
      (p) =>
        p.piece !== null &&
        !disabled(p.identifier) &&
        hasSummary(assembly, p.piece) &&
        (p.system_prompt === false || ["main", "nsfw", "jailbreak", "enhanceDefinitions"].includes(p.identifier))
    )
    if (
      assembly.lcm?.summaries.length &&
      !hasSummaryPrompt &&
      !layer.length &&
      !beside.some(({ message }) => message.pieces.some((p) => hasSummary(assembly, p)))
    )
      layer.push({
        role: "system",
        content: (mode.st ? "Summary: " : "") + layerText(assembly.lcm.summaries, mode.st),
        pieces: [...(assembly.lcmPieces ?? [])],
        kind: "summary"
      })
    const renderedLayer = assembly.lcm ? layerText(assembly.lcm.summaries, mode.st) : ""
    const embeddedCost = (content: string) =>
      renderedLayer ? tokensOf({ content }) - tokensOf({ content: content.split(renderedLayer).join("") }) : 0
    const layerCost =
      layer.reduce((n, message) => n + tokensOf(message), 0) +
      collection.reduce(
        (n, prompt) =>
          n + (prompt.piece !== null && hasSummary(assembly, prompt.piece) ? embeddedCost(prompt.content) : 0),
        0
      ) +
      beside.reduce(
        (n, { message }) => n + (message.pieces.some((p) => hasSummary(assembly, p)) ? tokensOf(message) : 0),
        0
      )
    return { collection, beside, injections, layer, layerCost }
  }
  const baseCollection = collection
  const actualPlacement = placement(notes)
  let reservedPlacement = actualPlacement
  const lines = projected.map((p, i) => chatLine(assembly, p, groupNames, scripted[i]!))
  prefill(assembly)
  const newExampleChat = optional("utility.new_example_chat_prompt", utility.new_example_chat_prompt)
  const schemaReserve =
    assembly.prefill && assembly.model?.prefill === "tool_schema" ? schemaPrefillBudget(assembly.prefill) : null
  const prefillInput = schemaReserve?.input ?? (assembly.prefill ? tokensOf({ content: assembly.prefill }) : 0)
  const prefixOutput = schemaReserve?.output ?? 0
  if (schemaReserve && doc.samplers.openai_max_tokens + prefixOutput > (assembly.model?.maxOutput ?? Infinity))
    throw new AssemblyFailed({
      reason: "budget",
      message: `The source prefix and requested continuation need about ${doc.samplers.openai_max_tokens + prefixOutput} output tokens, beyond ${assembly.model!.key}'s ${assembly.model!.maxOutput}-token output limit. Choose a model with a larger output limit or reduce the preset's response length.`
    })
  const reserve =
    prefillInput + prefixOutput + (!mode.st && assembly.lorebooks?.length ? loreAllowance(assembly) - loreCost : 0)
  let maximum = contextBudget(assembly) - reserve
  let desiredTarget = targetBudget(assembly) - reserve
  let admittedExamples = examples
  // A cut inside a failed range replaces the whole range, never just an unexplained prefix.
  const normalizedStart = (start: number) => {
    let depth = projected[start]?.entry.depth ?? need(assembly, "target").depth
    for (const failure of assembly.lcmFailurePieces ?? []) {
      if (failure.from < depth + 1 && failure.to >= depth + 1) {
        while (start < projected.length && projected[start]!.entry.depth < failure.to) start++
        depth = projected[start]?.entry.depth ?? need(assembly, "target").depth
      }
    }
    return start
  }
  const failuresBefore = (start: number) => {
    const depth = projected[start]?.entry.depth ?? need(assembly, "target").depth
    return (assembly.lcmFailurePieces ?? []).filter((failure) => failure.to <= depth)
  }
  const candidate = (
    start: number,
    budget: number,
    withExamples = true,
    reserved = false,
    includeFailures = true,
    withoutHistory = false
  ) => {
    if (includeFailures) start = normalizedStart(start)
    const { beside, collection, injections, layer } = reserved ? reservedPlacement : actualPlacement
    const markers: Array<StMessage> = (includeFailures ? failuresBefore(start) : []).map((failure) => ({
      role: "system",
      content: assembly.pieces[failure.piece]!.text,
      pieces: [failure.piece],
      kind: "summary"
    }))
    return compose({
      layer: [...layer, ...markers],
      stableExamples: assembly.lcm !== undefined,
      beside,
      collection,
      disabled,
      chat: injectInChat(
        [...(withoutHistory ? [] : lines.slice(start)), ...(normalFill ? [normalFill] : [])],
        collection.filter((p) => p.injection_position === "absolute"),
        injections
      ),
      examples: withExamples ? admittedExamples : [],
      newChat,
      newExampleChat,
      sendIfEmpty: cast.type === "normal" ? null : sendIfEmpty,
      control,
      budget
    })
  }
  const postNames = {
    user: names.user,
    char: names.char,
    group: cast.characters.length > 1 ? cast.characters.map((c) => c.doc.name) : []
  }
  const cost = (built: ReturnType<typeof compose>) => {
    const messages = built.messages.filter((message) => message.content)
    const processed = postProcess(doc.squash ? squash(messages) : messages, doc.postprocess, postNames)
    const tokens = (messages: ReadonlyArray<StMessage>) => messages.reduce((sum, message) => sum + tokensOf(message), 0)
    return 3 + Math.max(tokens(built.messages), tokens(processed))
  }
  const fixedCost = cost(candidate(projected.length, Number.POSITIVE_INFINITY, false, false, false))
  const contextBudgetInfo = (nonHistoryTokens: number) => ({
    maximum: contextBudget(assembly) + doc.samplers.openai_max_tokens,
    target: targetBudget(assembly) + doc.samplers.openai_max_tokens,
    responseReserve: doc.samplers.openai_max_tokens + prefixOutput,
    nonHistoryTokens: nonHistoryTokens + prefillInput
  })
  if (fixedCost > maximum)
    throw new AssemblyFailed({
      reason: "budget",
      message: "The full notes, fixed context and response reserve don't fit the maximum context size.",
      contextBudget: contextBudgetInfo(fixedCost),
      preset: { ref: need(assembly, "preset").ref, scope: need(assembly, "preset").scope }
    })
  const layerReserve = assembly.lcm
    ? Math.max(0, Math.min(maximum - fixedCost, Math.ceil(contextBudget(assembly) * 0.15) - actualPlacement.layerCost))
    : 0
  if (assembly.lcm)
    assembly.lcmBudget = {
      target: Math.ceil(contextBudget(assembly) * 0.15),
      maximum: Math.ceil(contextBudget(assembly) * 0.25)
    }
  maximum -= layerReserve
  desiredTarget -= layerReserve
  const oldNotes = configurationChanged ? undefined : prior?.noteBudget
  const sizes = Object.fromEntries(
    notes
      .filter((note) => !hasSummary(assembly, note.text.piece))
      .map((note) => [note.id, Math.max(oldNotes?.sizes[note.id] ?? 0, note.baseline, note.text.text.length)])
  )
  const noteBudgetChanged =
    oldNotes !== undefined &&
    notes.some(
      (note) => !hasSummary(assembly, note.text.piece) && note.text.text.length > (oldNotes.sizes[note.id] ?? 0)
    )
  // Only unused capacity is speculative. Actual note text is always present in both budgets.
  const allowance = Math.max(
    0,
    Math.min(oldNotes?.allowance ?? Math.min(1024, loreBudget(assembly)), maximum - fixedCost)
  )
  const reserveNotes = (characters: number) => {
    let left = characters
    reservedPlacement = placement(
      notes.map((note) => {
        const extra = Math.min(left, Math.max(0, (sizes[note.id] ?? note.text.text.length) - note.text.text.length))
        left -= extra
        return { ...note, text: { ...note.text, text: note.text.text + "x".repeat(extra) } }
      })
    )
    return cost(candidate(projected.length, Number.POSITIVE_INFINITY, false, true, false))
  }
  let lowReserve = 0,
    highReserve = allowance * 4
  while (lowReserve < highReserve) {
    const mid = Math.ceil((lowReserve + highReserve) / 2)
    if (reserveNotes(mid) <= fixedCost + allowance) lowReserve = mid
    else highReserve = mid - 1
  }
  reserveNotes(lowReserve)
  const budgetCost = (start: number, withExamples = true, includeFailures = true) => {
    const actual = cost(candidate(start, Number.POSITIVE_INFINITY, withExamples, false, includeFailures))
    const reserved = cost(candidate(start, Number.POSITIVE_INFINITY, withExamples, true, includeFailures))
    return Math.max(actual, Math.min(reserved, actual + allowance))
  }
  const admit = () => {
    let low = 0,
      high = examples.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      admittedExamples = examples.slice(0, mid)
      if (budgetCost(projected.length, true, false) <= maximum) low = mid
      else high = mid - 1
    }
    admittedExamples = examples.slice(0, low)
  }
  if (configurationChanged || noteBudgetChanged) admit()
  else admittedExamples = examples.slice(0, prior.examples)
  const minimum = budgetCost(projected.length, true, false)
  let target = Math.max(desiredTarget, minimum)
  const fits = (start: number, budget: number) => {
    start = normalizedStart(start)
    const built = candidate(start, Number.POSITIVE_INFINITY, true, true)
    const pieces = new Set(built.messages.flatMap((m) => m.pieces))
    return (
      lines.slice(start).every((line) => !line.content || line.pieces.every((piece) => pieces.has(piece))) &&
      budgetCost(start) <= budget
    )
  }
  const earliestFit = (end: number) => {
    let low = 0,
      high = end
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (fits(mid, target)) high = mid
      else low = mid + 1
    }
    return low
  }
  const earlier = previous ? projected.findIndex((p) => p.entry.depth >= previous.depth) : 0
  let start = earlier < 0 ? projected.length : earlier
  let budget = maximum
  const mayRestore =
    !assembly.lcm &&
    prior &&
    (contextBudget(assembly) > prior.maximum ||
      targetBudget(assembly) > prior.target ||
      identity !== prior.identity ||
      assembly.historyRevision !== prior.revision)
  const exceeded =
    !fits(start, maximum) ||
    (previous !== null &&
      previous !== undefined &&
      previous.depth < (assembly.history?.[0]?.depth ?? 0) &&
      (assembly.historyOmitted ?? 0) > 0)
  if (exceeded) {
    admit()
    target = Math.max(desiredTarget, budgetCost(projected.length, true, false))
  }
  const restored = mayRestore ? earliestFit(start) : start
  if (previous && restored < start) {
    start = restored
    budget = target
    assembly.historyMove = "restore"
  } else if (exceeded || (!assembly.lcm && noteBudgetChanged)) {
    assembly.historyMove = exceeded ? "maximum" : "budget"
    start = Math.max(previous ? start : 0, earliestFit(projected.length))
    budget = target
  } else assembly.historyMove = previous ? "unchanged" : "initial"
  start = normalizedStart(start)
  assembly.contextBudget = contextBudgetInfo(cost(candidate(start, Number.POSITIVE_INFINITY, true, false, true, true)))
  const first = projected[start]?.entry
  assembly.historyStart = {
    slotId: first?.slotId ?? null,
    depth: first?.depth ?? need(assembly, "target").depth,
    state: {
      configuration,
      identity,
      maximum: contextBudget(assembly),
      target: targetBudget(assembly),
      examples: admittedExamples.length,
      noteBudget: { sizes, allowance },
      revision: assembly.historyRevision ?? 0
    }
  }
  const composition = {
    ...candidate(start, budget),
    historyBudget:
      candidate(projected.length, maximum, true, false, false).historyBudget -
      failuresBefore(start).reduce((n, failure) => n + tokensOf({ content: assembly.pieces[failure.piece]!.text }), 0),
    examplesTotal: examples.length
  }
  assembly.postNames = postNames
  assembly.composition = composition
  if (assembly.lcm) {
    assembly.lcmFailures = failuresBefore(start).map(({ from, to }) => ({ from, to }))
    for (const failure of assembly.lcmFailures)
      assembly.issues.push({
        kind: "summary_failed",
        message: `Messages ${failure.from}–${failure.to} could not be summarized; a failure marker replaces their originals.`
      })
    const sentPieces = new Set(composition.messages.flatMap((m) => m.pieces))
    const retained = projected.filter((p) => sentPieces.has(p.piece))
    const truncated =
      start > 0 || composition.historySent < composition.historyTotal || (assembly.historyOmitted ?? 0) > 0
    const first = truncated
      ? Math.min(need(assembly, "target").depth, ...retained.map((p) => p.entry.depth))
      : assembly.lcm.cursorDepth + 1
    assembly.lcmOmitted =
      first > assembly.lcm.cursorDepth + 1 ? [{ from: assembly.lcm.cursorDepth + 2, to: first }] : []
    assembly.lcmVerbatim =
      first < need(assembly, "target").depth ? { from: first + 1, to: need(assembly, "target").depth } : null
  }
  if (start > 0 || composition.historySent < composition.historyTotal || (assembly.historyOmitted ?? 0) > 0) {
    assembly.issues.push({
      kind: "history_truncated",
      message: assembly.lcmOmitted?.length
        ? assembly.lcmOmitted.map((r) => `Messages ${r.from}–${r.to} left out: not summarized yet.`).join(" ")
        : `The context holds the last ${composition.historySent} messages: older ones don't fit the preset's context size.`
    })
  }
  if (composition.examplesSent < composition.examplesTotal) {
    assembly.issues.push({
      kind: "examples_truncated",
      message: `${composition.examplesTotal - composition.examplesSent} example dialogues didn't fit the preset's context size.`
    })
  }
})

/** Squashing and post-processing, as ST does them before sending (ARCHITECTURE §15). */
const messagesStage = sync("messages", (assembly) => {
  const doc = need(assembly, "preset").doc
  // An empty skipped note still marks the next sent message as the potential boundary.
  let barrier = false
  let messages: Array<StMessage> = need(assembly, "composition").messages.map((message) => {
    if (message.kind === "volatile" || message.pieces.some(need(assembly, "macros").isVolatile)) barrier = true
    const summary = message.pieces.some((p) => hasSummary(assembly, p))
    return {
      ...message,
      ...(barrier ? { kind: "volatile" as const } : summary ? { kind: "summary" as const } : {}),
      summary
    }
  })
  messages = messages.filter((m) => m.content)
  if (doc.squash) messages = squash(messages)
  messages = postProcess(messages, doc.postprocess, need(assembly, "postNames"))
  assembly.messages = messages.map(({ role, content, name, pieces, kind }) => ({
    role,
    content,
    ...(name !== undefined ? { name } : {}),
    pieces,
    kind
  }))
})

/** The provider-neutral request, and which message each piece ended up in. */
const requestStage = sync("request", (assembly) => {
  const doc = need(assembly, "preset").doc
  const messages = need(assembly, "messages")
  const s = doc.samplers
  const firstSummary = messages.findIndex((m) => m.pieces.some((p) => hasSummary(assembly, p)))
  if ((assembly.lcm?.summaries.some((s) => s.content !== "") || assembly.lcmFailures?.length) && firstSummary < 0)
    throw new AssemblyFailed({
      reason: "invalid_document",
      message: "This preset has no enabled placement for its summaries."
    })
  assembly.result = {
    ...(firstSummary >= 0 ? { summaryStart: firstSummary } : {}),
    messages: messages.map(({ role, content, name }) => ({ role, content, ...(name ? { name } : {}) })),
    prefill: assembly.prefill ?? null,
    samplers: {
      temperature: s.temperature,
      frequency_penalty: s.frequency_penalty,
      presence_penalty: s.presence_penalty,
      top_p: s.top_p,
      top_k: s.top_k,
      top_a: s.top_a,
      min_p: s.min_p,
      repetition_penalty: s.repetition_penalty,
      max_tokens: s.openai_max_tokens,
      seed: s.seed
    },
    useSystemPrompt: doc.use_sysprompt,
    breakpoints: assembly.breakpoints ?? [],
    names: assembly.postNames ?? { user: "", char: "", group: [] }
  }
  const mark = (piece: number, i: number) => {
    const record = assembly.pieces[piece]!
    if (!record.messages.includes(i)) record.messages.push(i)
    for (const part of record.parts ?? []) mark(part, i)
  }
  messages.forEach((message, i) => {
    for (const piece of message.pieces) mark(piece, i)
  })
})

const breakpointsStage = sync("breakpoints", (assembly) => {
  assembly.breakpoints = placeBreakpoints(
    need(assembly, "messages").map((m) => ({ ...m, summary: m.pieces.some((p) => hasSummary(assembly, p)) }))
  )
})

const builtinStages: ReadonlyArray<AssemblerStage> = [
  pathStage,
  stateStage,
  castStage,
  modelStage,
  presetStage,
  notesStage,
  modeStage,
  lorebooksStage,
  lcmStage,
  macrosStage,
  scriptsStage,
  historyStage,
  resolveStage,
  rolesStage,
  noteGateStage,
  loreScanStage,
  loreActivationStage,
  composeStage,
  messagesStage,
  breakpointsStage,
  requestStage
]

export const registerBuiltinStages = (registry: StageRegistry): Effect.Effect<void, never, Scope.Scope> =>
  Effect.forEach(builtinStages, (stage) => registry.register(stage), { discard: true })

import { budgetTokens } from "@rp/shared/imageTokens.ts"
import { replySectionsOf, sectionsPrefix } from "@rp/shared/replySections.ts"
import { modelName } from "@rp/shared/cardNames.ts"
import { withModelSettings } from "@rp/shared/modelSettings.ts"
import { fitPair, resolveLcm, summaryMacroPrompts } from "@rp/shared/lcmSettings.ts"
import { charDefinitions, newestMessage, presetOrder, withMain } from "@rp/shared/presetOrder.ts"
import { CARD_JOIN_PREFIX, CARD_JOIN_SUFFIX, type PromptCondition } from "@rp/shared/docs/preset.ts"
import { conditionOf, triggersFor } from "@rp/shared/presetConditions.ts"
import {
  CONTINUE_NUDGE,
  CONTINUE_TEXT,
  DIRECTION_PROMPT,
  endOfRequestText,
  FALLBACK_TEXT,
  GROUP_NUDGE,
  IMPERSONATION_PROMPT
} from "@rp/shared/endOfRequest.ts"
import { schemaPrefillBudget } from "./prefill.ts"
import { lcmStage, summaryBlock } from "./lcm.ts"
import { imageTokensStage, limitImageEstimates } from "./imageTokens.ts"
import { configurationOf, previousStart } from "./cutState.ts"
import { contextBudget, targetBudget, loreAllowance, loreBudget } from "./budget.ts"
// The built-in assembler stages, in registration order (ARCHITECTURE §15 lists them).
import type { ChatMessage } from "@rp/shared/macros/context.ts"
import type { CardFields } from "@rp/shared/macros/context.ts"
import type { VariableEffect } from "@rp/shared/macros/variables.ts"
import { branchOwned, type ChatState, foldState, noteSwitches, swappedCard } from "@rp/shared/state.ts"
import { isAuthorNote as isChatAuthorNote, noteCondition } from "@rp/shared/docs/note.ts"
import { Effect, type Scope } from "effect"
import { loreActivationStage, lorebooksStage } from "./loreStages.ts"
import { SUMMARY_HISTORY, summaryOnPath as selectSummary } from "./summary.ts"
import { placeBreakpoints } from "./breakpoints.ts"
import { DEFAULT_MAX_IMAGES, imagesStage, messageImagesOf } from "./images.ts"
import { cardBlock, personaBlock } from "./layouts.ts"
import { cardFields, makeMacroEnvironment, type MessagePosition, type Names } from "./macros.ts"
import {
  applyScripts,
  compile,
  makeScriptRunner,
  PLACEMENT,
  REGEX_MS,
  REGEX_OUTPUT,
  type PromptScript,
  type ScriptRunner
} from "./regex.ts"
import { builtinScriptSources, type ScriptSource } from "./scriptSources.ts"
import type { RegexScript } from "@rp/shared/docs/regexScript.ts"
import type { ScriptRef } from "@rp/shared/regexScripts.ts"
import {
  type Assembly,
  type AssemblerStage,
  AssemblySources,
  type Cast,
  type Mode,
  need,
  type PositionedEvent,
  type ProjectedEntry,
  type ProjectionRegistry,
  type RoleProjection,
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
  estimateTokens
} from "./st.ts"
import {
  AssemblyFailed,
  type CardInput,
  type GenerationType,
  type HistoryEntry,
  characterNoteText,
  historyLeafOf,
  type NoteInput,
  noteCard,
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

const presetSource = (
  assembly: Assembly,
  identifier: string,
  condition?: Exclude<PromptCondition, "always">
): Source => {
  const preset = need(assembly, "preset")
  return { kind: "preset", ref: preset.ref, revision: preset.revision, identifier, ...(condition ? { condition } : {}) }
}

const cardSource = (assembly: Assembly, card: CardInput, field: string): Source => ({
  kind: "card",
  entity: card.entity,
  revision: card.revision,
  ...(need(assembly, "cast").personas.some((p) => p.entity === card.entity) ? { persona: true } : {}),
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
      const events = yield* sources.events(historyLeafOf(need(assembly, "target")))
      assembly.events = events
      assembly.state = foldState(events.map((e) => e.event))
      return assembly
    })
}

/** The cast a state names, its cards through their layers; `speaker` speaks, when it's known. */
const castOf = (state: ChatState, speakerId: string | null, ordinal: number) =>
  Effect.gen(function* () {
    const sources = yield* AssemblySources
    const selected = state.playedByMe.slice(-1)
    const played = new Set(selected)
    const wanted = [...new Set([...state.participants, ...state.playedByMe, ...(speakerId ? [speakerId] : [])])]
    const cards = new Map((yield* sources.cards(wanted, state.cardBindings)).map((c) => [c.entity, c]))
    const characters = wanted.filter((e) => !played.has(e)).flatMap((e) => cards.get(e) ?? [])
    const personas = selected.flatMap((e) => cards.get(e) ?? [])
    const absent = new Set(state.absent)
    // A muted character is never picked to speak (DESIGN §3.5); it speaks only when named.
    const speaker =
      (speakerId ? cards.get(speakerId) : undefined) ?? characters.find((c) => !absent.has(c.entity)) ?? null
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
      assembly.cast = yield* castOf(
        need(assembly, "state"),
        swappedCard(
          need(assembly, "events").map((e) => e.event),
          target.speaker
        ),
        target.ordinal
      )
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
      assembly.model = yield* sources.model(null)
      return assembly
    })
}

const presetStage: AssemblerStage = {
  id: "preset",
  run: (assembly) =>
    Effect.gen(function* () {
      const sources = yield* AssemblySources
      assembly.preset = yield* sources.preset({ role: null, chat: null, connection: null })
      const model = assembly.model
      if (model?.settings)
        assembly.preset = {
          ...assembly.preset,
          doc: withModelSettings(assembly.preset.doc, model.settings, model.context, model.maxOutput)
        }
      return assembly
    })
}

/** Whether each note the events turned on or off is on, as they last left it. */
const switchesOf = (events: ReadonlyArray<PositionedEvent>) => noteSwitches(events.map((e) => e.event))

/** A card's note on in every chat unless the chat switches it off (`on_by_default`). */
const onByDefault = (note: NoteInput) => noteCard(note.doc) !== null && note.doc.on_by_default === true

/**
 * The notes that are on (DESIGN §4.1): a card's note with `on_by_default` (an imported
 * Character's Note, which ST always sends) unless the chat turned it off; any other note,
 * the chat's own included, once the chat turns it on (`note.activate`). A slot linked to a
 * shared note that's gone (in the bin) sends nothing.
 */
const activeNotes = (events: ReadonlyArray<PositionedEvent>, notes: ReadonlyArray<NoteInput>) => {
  const last = switchesOf(events)
  return notes.filter((note) => (last.get(note.entity) ?? onByDefault(note)) && note.link?.revision !== null)
}

/** Whether a note has a condition, which makes it come and go with the turn (DESIGN §4.1). */
const conditioned = (note: NoteInput) => noteCondition(note.doc).when !== "always"

/**
 * Whether a note's condition holds for the message being generated: on a card's turn, when
 * that card is its speaker (a swipe's or continuation's included); while a card isn't muted.
 * A card that isn't in the cast at the leaf holds neither.
 */
const noteConditionHolds = (note: NoteInput, cast: Cast) => {
  const condition = noteCondition(note.doc)
  if (condition.when === "always") return true
  if (![...cast.characters, ...cast.personas].some((c) => c.entity === condition.card)) return false
  return condition.when === "turn" ? cast.speaker?.entity === condition.card : !isMuted(cast, condition.card)
}

/** Whether a card is muted at the leaf (DESIGN §3.5): unit P1-1's mute is `presence.set`. */
const isMuted = (cast: Cast, entity: string) => cast.absent.has(entity)

/** A condition in words, for the request inspector. */
const conditionText = (note: NoteInput, cast: Cast) => {
  const condition = noteCondition(note.doc)
  if (condition.when === "always") return undefined
  const card = [...cast.characters, ...cast.personas].find((c) => c.entity === condition.card)
  const name = card ? modelName(card.doc) : "a card not in the chat"
  return condition.when === "turn" ? `on ${name}'s turn` : `while ${name} isn't muted`
}

/** The chat's author's note, whose place notes and lore at its top or bottom ride on (shown on the note). */
const isAuthorNote = (state: ChatState, note: NoteInput) =>
  noteCard(note.doc) === null && isChatAuthorNote(note.doc, note.entity, state.authorNote)

/**
 * An imported summary as ST would send it on this path: the newest of its texts saved on a
 * message of the path, up to the leaf (DATA-MODEL §15, invariant 5); none when the path has
 * none of them. A text with no message (one the user wrote) applies anywhere. The
 * template and placement are the current revision's, which alone keeps them.
 */
const summaryOnPath = (notes: ReadonlyArray<NoteInput>, target: Target) =>
  Effect.gen(function* () {
    const sources = yield* AssemblySources
    const leaf = historyLeafOf(target)
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
      const notes = yield* sources.notes(
        [...cast.characters, ...cast.personas].map((c) => c.entity),
        state.noteRevisions
      )
      const active = yield* summaryOnPath(activeNotes(need(assembly, "events"), notes), target)
      // A summary request sends no notes unless the chat says so: they can tell of events after
      // the chunk (DESIGN §8).
      if (
        assembly.request.summarizing &&
        !resolveLcm(state.lcm, sources.lcmDefaults ? yield* sources.lcmDefaults() : null).withNotes
      ) {
        assembly.notes = []
        return assembly
      }
      const off = notes.find((note) => isAuthorNote(state, note) && !active.includes(note))
      if (off) assembly.offAuthorNote = off
      assembly.notes = active
      return assembly
    })
}

/**
 * Gate after the history's roles exist, before any note can change its last role: a note
 * whose condition doesn't hold this turn isn't due. It sends no text and has no macro
 * effects, but keeps its place as a cache boundary. A note's old `interval` is ignored.
 */
const noteGateStage = sync("note-gate", (assembly) => {
  assembly.sendIfEmpty =
    need(assembly, "projected").at(-1)?.role === "assistant" &&
    need(assembly, "preset").doc.utility_prompts.send_if_empty !== ""
  const cast = need(assembly, "cast")
  const active = assembly.notes ?? []
  const switches = switchesOf(need(assembly, "events"))
  const holds = new Map(active.map((note) => [note.entity, noteConditionHolds(note, cast)]))
  assembly.noteDecisions = new Map(
    active.map((note) => {
      const condition = conditionText(note, cast)
      return [
        note.entity,
        {
          kind: "note" as const,
          activation: switches.get(note.entity) === true ? ("explicit" as const) : ("default" as const),
          interval: null,
          userMessages: null,
          ...(condition === undefined ? {} : { condition }),
          due: holds.get(note.entity)!
        }
      ]
    })
  )
  assembly.skippedNotes = active.filter((note) => !holds.get(note.entity))
  assembly.notes = active.filter((note) => holds.get(note.entity))
})

const modeOf = (state: ChatState): Mode => ({
  projection: state.rolesProjection ?? "by_writer",
  loreBelowHistory: state.loreBelowHistory ?? true
})

const modeStage = sync("mode", (assembly) => {
  const state = need(assembly, "state")
  assembly.mode = modeOf(state)
  // Card layout is the preset's, never the chat's (DESIGN §5.0): an old choice is ignored, and said once.
  if (state.layoutCards !== null)
    assembly.issues.push({
      kind: "layout_ignored",
      message: `This chat chose the "${state.layoutCards}" card layout, which no longer applies: the preset's markers place the cards.`
    })
})

/**
 * The bindings macros see (DESIGN §5.3): in preset text `{{char}}` is the cast and `{{user}}`
 * the characters the user plays, which for one character and one persona are ST's.
 */
const namesFor = (state: ChatState, cast: Cast): Names => {
  const pinned = state.macroBindings
  const join = (cards: ReadonlyArray<CardInput>) => cards.map((c) => modelName(c.doc)).join(", ")
  const everyone = [...cast.characters, ...cast.personas]
  const persona = cast.personas.at(-1)
  return {
    user: pinned["user"] ?? (persona ? modelName(persona.doc) || "User" : "User"),
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
 * same from turn to turn, with its in-chat notes that are on as ST's Character's Note.
 */
const macroCard = (cast: Cast, notes: ReadonlyArray<NoteInput> | undefined) => {
  const card = cast.characters[0]
  return cardFields(card, cast.personas[0], characterNoteText(notes, card?.entity))
}

const macrosStage = sync("macros", (assembly) => {
  const cast = need(assembly, "cast")
  const preset = need(assembly, "preset").doc
  const written = summaryNotes(assembly).filter((note) => note.doc.content.trim() !== "")
  // The note gate comes later; a summary note not due by its condition fills nothing, as it sends nothing.
  const switchedOn = written.filter((note) => noteConditionHolds(note, cast))
  const filled = switchedOn.map((note) => note.doc.content.trim()).join("\n\n")
  assembly.summaryFill = {
    prompts: summaryMacroPrompts(preset),
    kind: switchedOn.length ? "notes" : "none",
    count: switchedOn.length,
    tokens: estimateTokens(filled),
    titles: switchedOn.map((note) => note.doc.title)
  }
  assembly.macros = makeMacroEnvironment(assembly, {
    names: namesFor(need(assembly, "state"), cast),
    card: macroCard(cast, assembly.notes),
    collapseNewlines: preset.collapse_newlines === true,
    messages: [],
    model: assembly.model?.key ?? "",
    maxContextTokens: preset.samplers.openai_max_context,
    maxResponseTokens: preset.samplers.openai_max_tokens,
    type: cast.type,
    chatId: need(assembly, "target").chatId,
    variables: need(assembly, "state").vars,
    // `{{summary}}` is ST's one summary (DESIGN §8): the chat's switched-on summary notes on this
    // path that are due by their condition, in note order, never the summaries; a note that is off
    // sends nothing anywhere. A condition can change from turn to turn, so then it's never cached.
    summary: filled,
    summaryVolatile: written.some((note) => noteCondition(note.doc).when !== "always"),
    // Who the model writes as, and the direction (DESIGN §2.2); a summary has neither.
    ...(assembly.request.summarizing
      ? {}
      : {
          speaker: cast.speaker ? modelName(cast.speaker.doc) : namesFor(need(assembly, "state"), cast).char,
          direction: need(assembly, "target").direction ?? ""
        })
  })
})

const scriptsStage: AssemblerStage = {
  id: "scripts",
  run: (assembly) =>
    Effect.gen(function* () {
      const lists: Array<{ readonly source: ScriptSource; readonly scripts: ReadonlyArray<RegexScript> }> = []
      for (const source of assembly.request.scriptSources?.list() ?? builtinScriptSources)
        lists.push({ source, scripts: yield* source.scripts(assembly) })
      assembly.scripts = compileScripts(assembly, lists)
      return assembly
    })
}

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
      assembly.previousHistoryStart = yield* sources.historyStart(historyLeafOf(target))
      assembly.historyRevision = yield* sources.historyRevision(
        historyLeafOf(target),
        assembly.previousHistoryStart?.depth ?? 0
      )
      const budget = contextBudget(assembly)
      const scripted = new Map<string, Scripted>()
      let entries: ReadonlyArray<HistoryEntry> = []
      let leaf = historyLeafOf(target)
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
          const result = {
            ...results[i]!,
            text: clipForSummary(assembly, results[i]!.text || (entry.images?.length ? "[Image]" : ""))
          }
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

/**
 * Tagged sections at the start of replies (spec/REPLY-SECTIONS.md) go back to the model only
 * as the preset says: the last `send_back` replies of the card being written that have them,
 * in their original tags before the text, as ST's `add_to_prompts` / `max_additions` (only
 * the speaker's own, as ST does in a group). They're volatile: they leave as the chat grows.
 * Never in a summary request.
 */
const replySectionsStage = sync("reply-sections", (assembly) => {
  const { send_back: sendBack } = replySectionsOf(need(assembly, "preset").doc)
  // A summary sees the replies' text only.
  if (sendBack === 0 || assembly.request.summaryJob) return
  const speaker = need(assembly, "cast").speaker?.entity ?? null
  const scripted = new Map(need(assembly, "scripted"))
  let left = sendBack
  for (const entry of [...need(assembly, "history")].reverse()) {
    if (left === 0) break
    // Another card's (both known and different) are skipped without counting.
    if (!entry.inContext || !entry.replySections?.sections.length) continue
    if (speaker !== null && entry.speaker !== null && entry.speaker !== speaker) continue
    const read = scripted.get(entry.versionId)
    if (!read) continue
    // Each section's text through the prompt-only reasoning scripts at the message's depth,
    // as ST runs them on the reasoning it adds to a prompt, then back in its tags.
    const sections = entry.replySections
    const texts = applyScripts(
      assembly,
      need(assembly, "scripts"),
      sections.sections.map((section) => ({ text: section.text, placement: PLACEMENT.reasoning, depth: read.depth }))
    )
    const prefix = sectionsPrefix({
      ...sections,
      sections: sections.sections.map((section, i) => ({ ...section, text: texts[i]!.text }))
    })
    const applied = [...(read.applied ?? []), ...texts.flatMap((text) => text.applied ?? [])]
    scripted.set(entry.versionId, {
      ...read,
      text: prefix + read.text,
      volatile: true,
      ...(applied.length ? { applied } : {})
    })
    left--
  }
  assembly.scripted = scripted
})

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
    const position: Position = { cast, names: namesFor(state, cast), card: macroCard(cast, notes) }
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
        written.length === 0
          ? events
          : [...events, ...written].sort(
              (a, b) =>
                Number(branchOwned.has(a.event.data.key)) - Number(branchOwned.has(b.event.data.key)) ||
                (a.depth ?? -1) - (b.depth ?? -1)
            )
      for (const entry of need(assembly, "history")) {
        // A display path's positions include summarized history and deleted gaps. Keep
        // numbering aligned without changing the message arrays used by older snapshots.
        if (need(assembly, "target").displayPositions) while (messages.length < entry.depth) messages.push(omitted)
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
          const own = speaker && !position.cast.personas.includes(speaker) ? { char: modelName(speaker.doc) } : {}
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
        const piece = env.message(
          entry.content || !entry.images?.length ? entry : { ...entry, content: "[Image]" },
          messages,
          at
        )
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
      // A speaker who has left (an earlier persona, say) still names its messages (owner 2026-10-28).
      const inCast = new Set([...cast.characters, ...cast.personas].map((c) => c.entity))
      const gone = [
        ...new Set(
          resolved.flatMap(({ entry }) => (entry.speaker && !inCast.has(entry.speaker) ? [entry.speaker] : []))
        )
      ]
      const departed =
        gone.length > 0 ? yield* (yield* AssemblySources).cards(gone, need(assembly, "state").cardBindings) : []
      assembly.departed = new Map(departed.map((card) => [card.entity, card]))
      return assembly
    })
}

/**
 * Role projection (DESIGN §5.4): by writer (ST's: the user's side is `user`), strict
 * alternation by position (even depths, the greeting's, are `assistant`), or by
 * perspective (the speaker's own turns are `assistant`).
 */
const builtinProjections: ReadonlyArray<RoleProjection> = [
  {
    id: "by_writer",
    label: "By writer",
    description: "Yours as user, the model's as assistant.",
    role: ({ side }) => side
  },
  {
    id: "alternate",
    label: "Alternating",
    description: "Strictly alternating by position, for models that require it.",
    role: ({ entry }) => (entry.depth % 2 === 0 ? "assistant" : "user")
  },
  {
    id: "perspective",
    label: "By perspective",
    description: "The replying character's own turns as assistant, everyone else's as user.",
    role: ({ speaker, cast }) => (speaker !== undefined && speaker === cast.speaker ? "assistant" : "user")
  }
]

export const registerBuiltinProjections = (registry: ProjectionRegistry): Effect.Effect<void, never, Scope.Scope> =>
  Effect.forEach(builtinProjections, (projection) => registry.register(projection), { discard: true })

const rolesStage = sync("roles", (assembly) => {
  const cast = need(assembly, "cast")
  const { projection: chosen } = need(assembly, "mode")
  // Resolved at use: a plugin's projection may be gone since the chat chose it.
  const found = assembly.request.projections.get(chosen)
  if (!found) {
    assembly.issues.push({
      kind: "role_projection_missing",
      message: `This chat's role projection "${chosen}" isn't installed (a plugin may be off); roles are by writer instead.`
    })
  }
  const projection = found ?? assembly.request.projections.get("by_writer")
  const names = need(assembly, "macros").names
  assembly.projected = need(assembly, "resolved").map(({ entry, piece }): ProjectedEntry => {
    const speaker = speakerOf(entry, cast)
    const side = sideOf(entry, cast)
    const persona = speaker ? cast.personas.includes(speaker) : side === "user"
    // A speaker who has left still names its own messages; otherwise the side's first card does.
    const named =
      (entry.speaker && !recorded(entry, cast) ? assembly.departed?.get(entry.speaker) : undefined) ?? speaker
    const role = projection?.role({ entry, cast, speaker, side }) ?? side
    return {
      entry,
      role,
      name: (named ? modelName(named.doc) : undefined) ?? (persona ? names.user : names.char),
      persona,
      piece
    }
  })
})

/** ST's baseChatReplace collapses expanded card fields, before removing carriage returns. */
const cardNewlines = (assembly: Assembly, piece: number): Text => {
  const original = need(assembly, "macros").text(piece)
  const text = (need(assembly, "preset").doc.collapse_newlines ? original.replace(/\n+/g, "\n") : original).replace(
    /\r/g,
    ""
  )
  assembly.pieces[piece] = { ...assembly.pieces[piece]!, text }
  return { text, piece }
}

/** A card field as ST's baseChatReplace gives it: trimmed, expanded without card fields, no carriage returns. */
const cardText = (assembly: Assembly, card: CardInput, field: keyof CardInput["doc"], names?: Partial<Names>): Text => {
  const env = need(assembly, "macros")
  const raw = String(card.doc[field] ?? "").trim()
  const piece = env.piece(`card:${card.entity}:${String(field)}`, cardSource(assembly, card, String(field)), raw, {
    withoutCard: true,
    ...(names ? { names } : {})
  })
  return cardNewlines(assembly, piece)
}

const presetText = (
  assembly: Assembly,
  id: string,
  text: string,
  names: Partial<Names> = {},
  condition?: Exclude<PromptCondition, "always">
): Text => {
  const env = need(assembly, "macros")
  const piece = env.piece(`preset:${id}`, presetSource(assembly, id, condition), text, { names })
  const expanded = env.text(piece)
  return { text: expanded, piece, volatile: env.isVolatile(piece) }
}

/** Whether a prompt's condition holds for this generation (DESIGN §2.2). */
const conditionHolds = (assembly: Assembly, condition: PromptCondition) => {
  // A summary isn't written as anyone, and has no direction: only prompts sent always.
  if (assembly.request.summarizing) return condition === "always"
  const { speaker, personas } = need(assembly, "cast")
  switch (condition) {
    case "always":
      return true
    case "as_user":
      return speaker !== null && personas.includes(speaker)
    case "as_character":
      return speaker !== null && !personas.includes(speaker)
    case "with_direction":
      return Boolean(need(assembly, "target").direction?.trim())
  }
}

/**
 * The prompt collection, as ST's PromptManager builds it: the order's enabled prompts whose
 * condition holds and whose ST triggers allow this generation type, prepared (macros
 * expanded); a disabled `main` stays as an empty prompt. A conditioned prompt after the
 * history changes from turn to turn, so it's never inside the cached part.
 */
const collectionOf = (assembly: Assembly): Array<StPrompt> => {
  const doc = withMain(need(assembly, "preset").doc)
  const type = need(assembly, "cast").type
  const prompts = new Map(
    [...doc.prompts, ...(doc.prompts.some((p) => p.identifier === "newestMessage") ? [] : [newestMessage])].map((p) => [
      p.identifier,
      p
    ])
  )
  const collection: Array<StPrompt> = []
  let afterHistory = false
  const skipped: Array<Source> = []
  for (const entry of presetOrder(doc.prompts, doc.order)) {
    const prompt = prompts.get(entry.identifier)
    // The end-of-request texts are sent by their own stage, never from the order (DESIGN §2.2).
    if (!prompt || endOfRequestText(prompt.identifier)) continue
    const condition = conditionOf(prompt)
    const allowed = entry.enabled && triggersFor(prompt, type) && conditionHolds(assembly, condition)
    if (entry.identifier === "chatHistory") afterHistory = true
    if (entry.enabled && !allowed) {
      if (!triggersFor(prompt, type))
        skipped.push({
          kind: "preset",
          ref: need(assembly, "preset").ref,
          revision: need(assembly, "preset").revision,
          identifier: prompt.identifier,
          triggers: [...prompt.injection_trigger]
        })
      else if (condition !== "always") skipped.push(presetSource(assembly, prompt.identifier, condition))
    }
    if (!allowed && entry.identifier !== "main") continue
    const text =
      allowed && prompt.content
        ? presetText(assembly, prompt.identifier, prompt.content, {}, condition === "always" ? undefined : condition)
        : null
    const summary = text !== null && hasSummary(assembly, text.piece)
    collection.push({
      identifier: prompt.identifier,
      role: text && summary ? "system" : prompt.role,
      ...(summary
        ? { kind: "summary" as const }
        : afterHistory && condition !== "always"
          ? { kind: "volatile" as const }
          : {}),
      content: text?.text ?? "",
      piece: text?.piece ?? null,
      system_prompt: prompt.system_prompt,
      injection_position: prompt.injection_position,
      injection_depth: prompt.injection_depth,
      injection_order: prompt.injection_order,
      forbid_overrides: prompt.forbid_overrides
    })
  }
  assembly.skippedPrompts = skipped
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
 * A card's prompt override (the speaker's, DESIGN §5.0) replaces a preset prompt unless the
 * preset forbids it or turned it off. ST expands the override with the card's other fields, before the preset's prompts,
 * and fills `{{original}}` (the prompt it replaces) once the prompt is known: the first
 * `{{original}}` becomes it and any other nothing, as ST's macro does.
 */
const override = (
  assembly: Assembly,
  collection: Array<StPrompt>,
  disabled: (identifier: string) => boolean,
  identifier: "main" | "jailbreak",
  text: Text,
  card: CardInput
) => {
  // An empty card prompt does nothing, and isn't worth showing in the editors.
  if (!text.text) return
  const at = collection.findIndex((p) => p.identifier === identifier)
  const status =
    at === -1
      ? "missing"
      : collection[at]!.forbid_overrides
        ? "forbidden"
        : disabled(identifier)
          ? "disabled"
          : "replaced"
  assembly.cardOverrides?.push({ identifier, entity: card.entity, revision: card.revision, status })
  if (status !== "replaced") return
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
  if (continues) return continuePrefill(assembly, continues)
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
 * prefill (ST's "continue prefill"), so the model writes on from its end. Trailing whitespace
 * goes, which Anthropic refuses at the end of a prefill. A model that can't take one (its
 * capability `none`, or an endpoint without the prefill, `continueUnavailable`) gets the text
 * as its own last message instead, and the end-of-request instruction asks it to write only
 * what follows (owner, 2026-10-31; ST's continue nudge).
 */
const continuePrefill = (assembly: Assembly, continues: NonNullable<Target["continues"]>) => {
  const model = assembly.model
  if (!model) {
    throw new AssemblyFailed({ reason: "no_model", message: "Continue needs a model: none is chosen." })
  }
  const text = continues.text
  if (continuesWithoutPrefill(assembly)) {
    const piece = need(assembly, "macros").verbatim(
      `continue:${continues.version}`,
      { kind: "message", slot: need(assembly, "target").slotId, version: continues.version },
      text
    )
    const join = /\s$/.test(text) ? "" : need(assembly, "preset").doc.prefill.continue_postfix
    assembly.continuation = { text, piece, join }
    // A model that takes a prefill, but not here: say why it didn't get one.
    if (model.prefill !== "none" && model.continueUnavailable)
      assembly.issues.push({
        kind: "prefill_dropped",
        message: `Continue sent the reply as ${model.key}'s own last message with the continue instruction after it, not as a prefill: ${model.continueUnavailable}`
      })
    return
  }
  assembly.prefill = model.prefill === "tool_schema" ? text : text.trimEnd()
}

/** Continue on a model it can't prefill: the text it continues goes as the model's last message. */
const continuesWithoutPrefill = (assembly: Assembly): boolean =>
  need(assembly, "target").continues !== undefined &&
  assembly.model !== undefined &&
  assembly.model !== null &&
  (assembly.model.prefill === "none" || assembly.model.continueUnavailable !== undefined)

/** A message of the path as ST sends it, with the preset's names behavior (setOpenAIMessages). */
const chatLine = (
  assembly: Assembly,
  projected: ProjectedEntry,
  groupNames: boolean,
  scripted: { readonly text: string; readonly volatile: boolean }
): ChatLine => {
  const behavior = need(assembly, "preset").doc.names_behavior
  const text = scripted.text.replace(/\r/gm, "") || (projected.entry.images?.length ? "[Image]" : "")
  const pieces = [projected.piece]
  const images = projected.entry.images?.length ? { images: projected.entry.images } : {}
  const named = (prefix: boolean): ChatLine => ({
    role: projected.role,
    content: prefix ? `${projected.name}: ${text}` : text,
    ...images,
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

/** Patterns longer than this, after the case rewrite, are left out. */
const MAX_PATTERN = 2_000
/** Scripts after this many are left out. */
const MAX_SCRIPTS = 100

const SCOPE_NAMES = { global: "global", preset: "preset's", character: "character's" } as const

/**
 * The scripts of every registered list, in order (ARCHITECTURE §15): the prompt-only ones for
 * a context, or for a rewrite the ones with neither flag; the pattern compiled, with its macros
 * expanded when the script asks for that, and the replacement and trim strings expanded. Each
 * list decides whether its scripts may run (approval). A script that can't run safely is left
 * out and reported.
 */
const compileScripts = (
  assembly: Assembly,
  lists: ReadonlyArray<{ readonly source: ScriptSource; readonly scripts: ReadonlyArray<RegexScript> }>
): ScriptRunner => {
  const limits = { ms: REGEX_MS, output: REGEX_OUTPUT }
  const wanted = (script: RegexScript) =>
    assembly.request.rewrite ? !script.prompt_only && !script.markdown_only : script.prompt_only
  const usable = lists.flatMap(({ source, scripts }) =>
    scripts
      .filter((script) => !script.disabled && wanted(script) && script.find_regex)
      .map((script) => ({ source, script }))
  )
  if (usable.length > MAX_SCRIPTS) {
    assembly.issues.push({
      kind: "regex_skipped",
      message: `Only the first ${MAX_SCRIPTS} of the ${usable.length} ${assembly.request.rewrite ? "" : "prompt "}regex scripts run.`
    })
  }
  const list = usable.slice(0, MAX_SCRIPTS).flatMap(({ source, script }): Array<PromptScript> => {
    const what = source.scope === "preset" ? "The" : `The ${SCOPE_NAMES[source.scope]}`
    const skip = (why: string) => {
      assembly.issues.push({
        kind: "regex_skipped",
        message: `${what} regex script "${script.name}" was left out: ${why}.`
      })
      return []
    }
    // The preset's pieces keep their ids; other lists' are namespaced by scope.
    const key = source.scope === "preset" ? `regex:${script.id}` : `regex:${source.scope}:${script.id}`
    if (script.substitute_regex === "escaped") return skip("macros escaped into its pattern aren't supported")
    const find =
      script.substitute_regex === "raw"
        ? presetText(assembly, `${key}:find`, script.find_regex).text
        : script.find_regex
    const regex = compile(find)
    if (regex === "unsafe") {
      return skip(
        "it needs backtracking (backreferences, lookaheads, nested counted repeats or Unicode properties), which could stall the server"
      )
    }
    if (regex === null) return skip("its pattern isn't a valid regular expression")
    if (regex.source.length > MAX_PATTERN) return skip("its pattern is too long")
    const replacement = script.replace_string ? presetText(assembly, `${key}:replace`, script.replace_string).text : ""
    const trim = script.trim_strings.map((t, i) => presetText(assembly, `${key}:trim:${i}`, t).text)
    return [{ ref: { scope: source.scope, id: script.id, name: script.name }, script, regex, replacement, trim }]
  })
  return makeScriptRunner(list, limits)
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

/** A summary note of the chat's: kind `imported_summary`, as ST's Summarize extension kept it (DESIGN §8.1). */
const isSummaryNote = (note: NoteInput) => note.doc.kind === "imported_summary" && noteCard(note.doc) === null

/** The chat's summary notes that are switched on, in note order. */
const summaryNotes = (assembly: Assembly, notes = assembly.notes) => (notes ?? []).filter(isSummaryNote)

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
    owner ? { withoutCard: true, names: { char: modelName(owner.doc) } } : {}
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
  | {
      readonly at: "start" | "end" | "context_start" | "tail_start" | "tail_end"
      readonly volatile: boolean
      readonly role: Role
    }

const placeOf = (note: NoteInput): NotePlace | null => {
  const { placement } = note.doc
  switch (placement.mode) {
    case "depth":
      return { at: "chat", depth: placement.depth, role: placement.role }
    case "tail":
      return { at: "chat", depth: 0, role: placement.role }
    case "section":
      if (["context_start", "tail_start", "tail_end"].includes(placement.section))
        return {
          at: placement.section as "context_start" | "tail_start" | "tail_end",
          role: placement.role ?? "system",
          volatile: conditioned(note)
        }
      if (placement.section !== "before_main_prompt" && placement.section !== "after_main_prompt") return null
      // A card's note "with the definitions" goes inside its card's part (`withDefinitions`).
      if (withDefinitions(note)) return null
      return {
        at: placement.section === "before_main_prompt" ? "start" : "end",
        // A note that comes and goes with its condition changes the prefix it's in.
        volatile: conditioned(note),
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
 * it goes this turn (`due`); it doesn't by its condition (`skipped`), so nothing rides along;
 * it's switched off (`off`), so what rides on it goes where it sits without its text (owner
 * question 6; ST sends nothing of a frequency-0 note); or the chat has none (`none`), which
 * ST treats as its default note, empty, in-chat at depth 4 as the system, every message.
 */
type AuthorState = "due" | "skipped" | "off" | "none"

/**
 * Whether a card's note goes inside its card's part, at the top (DESIGN §4.1, owner 2026-10-28):
 * placed "with the definitions" (`after_main_prompt`, which a chat's note keeps beside the main
 * prompt) or, as older notes are, `section: card`.
 */
const withDefinitions = (note: NoteInput) =>
  noteCard(note.doc) !== null &&
  note.doc.placement.mode === "section" &&
  (note.doc.placement.section === "card" || note.doc.placement.section === "after_main_prompt")

/** The notes placed with a card's definition, at the top of its part, expanded, in id order. */
const cardNotes = (assembly: Assembly, card: CardInput, owner: CardInput | null): ReadonlyArray<Text> => {
  const env = need(assembly, "macros")
  const skipped = assembly.skippedNotes ?? []
  return [...(assembly.notes ?? []), ...skipped]
    .filter((note) => noteCard(note.doc) === card.entity && withDefinitions(note))
    .toSorted((a, b) => (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0))
    .flatMap((note) => {
      if (!conditioned(note)) {
        const text = noteText(assembly, note, owner)
        return text?.text ? [text] : []
      }
      // A conditioned note comes and goes with the turn, which changes its card's part: that
      // part is volatile, due or not (allowed above the history; the editor warns, DESIGN §4.1).
      env.potentialVariableWrite()
      const text = skipped.includes(note)
        ? { text: "", piece: env.verbatim(`note:${note.entity}`, noteSource(assembly, note), "") }
        : noteText(assembly, note, owner)
      if (!text) return []
      env.markVolatile(text.piece)
      return [text]
    })
}

/** A card's marker text with the notes placed with its definition above it. */
const withCardNotes = (assembly: Assembly, card: CardInput, owner: CardInput | null, field: Text | null) => {
  const top = cardNotes(assembly, card, owner)
  if (top.length === 0) return field
  const parts = field ? [...top, field] : top
  // A skipped conditioned note is an empty part: no text, but its piece keeps the part volatile.
  const text = parts
    .filter((part) => part.text)
    .map((part) => part.text)
    .join("\n")
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
  // A summary note is placed by its own switch alone, also beside summaries (DESIGN §8 [P]).
  const candidates = [...(assembly.notes ?? []), ...(assembly.skippedNotes ?? [])]
  const isSummary = (note: NoteInput) => isSummaryNote(note)
  const isPersona = (note: NoteInput) => personas.some((p) => p.entity === noteCard(note.doc))
  const rank = (note: NoteInput) =>
    isSummary(note) ? 0 : isPersona(note) ? 4 : noteCard(note.doc) !== null ? 3 : isAuthorNote(state, note) ? 1 : 2
  const sorted = candidates
    .filter((note) => note.doc.kind !== "imported_summary" || isSummary(note))
    .toSorted((a, b) => rank(a) - rank(b) || (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0))
  const authorNote = sorted.find((note) => isAuthorNote(state, note))
  const offNote = authorNote ? undefined : assembly.offAuthorNote
  const authorState: AuthorState = authorNote
    ? assembly.skippedNotes?.includes(authorNote)
      ? "skipped"
      : "due"
    : offNote
      ? "off"
      : "none"
  // A persona's text keeps the page's bindings: `{{char}}` is the character, not the persona.
  const textOf = (note: NoteInput, owner: CardInput | null) => (): Text | null => {
    const skipped = assembly.skippedNotes?.includes(note)
    // Every conditioned note is a potential writer; never expand a skipped one to find out.
    if (conditioned(note)) env.potentialVariableWrite()
    return skipped
      ? { text: "", piece: env.verbatim(`note:${note.entity}`, noteSource(assembly, note), "") }
      : isSummary(note)
        ? summaryText(assembly, note)
        : noteText(assembly, note, owner)
  }
  const ownerOf = (note: NoteInput) => {
    const card = noteCard(note.doc)
    return card === null ? null : (cards.find((c) => c.entity === card) ?? null)
  }
  const section = (note: NoteInput) => (note.doc.placement.mode === "section" ? note.doc.placement.section : null)
  const attached = (which: "author_note_top" | "author_note_bottom") =>
    authorState !== "skipped"
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
    const content = isSummary(note)
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
  // A switched-off author's note keeps its place, empty, for what rides on it.
  const offPlace = offNote ? placeOf(offNote) : null
  if (offNote && offPlace) {
    const after = placed.findIndex((note) => note.rank > rank(offNote))
    placed.splice(after < 0 ? placed.length : after, 0, {
      place: offPlace,
      id: offNote.entity,
      rank: rank(offNote),
      baseline: 0,
      author: true,
      text: () => ({ text: "", piece: env.verbatim(`note:${offNote.entity}`, noteSource(assembly, offNote), "") })
    })
  }
  return { placed, attachments, authorState }
}

/** The context as ST's populateChatCompletion builds it, filled the way the preset says. */
const composeStage = sync("compose", (assembly) => {
  let doc = withMain(need(assembly, "preset").doc)
  const cast = need(assembly, "cast")
  const mode = need(assembly, "mode")
  const env = need(assembly, "macros")
  const names = env.names
  const utility = doc.utility_prompts
  const disabled = disabledIn(doc)
  const optional = (id: string, text: string, options?: Partial<Names>) =>
    text ? presetText(assembly, id, text, options) : null
  const characters = cast.characters
  const group = characters.length > 1
  // The speaking card, a card the user plays included (owner 2026-10-28: its prompts apply on an
  // impersonation turn, as ST passes the character's prompts for every generation type).
  const speaker = cast.speaker
  const own = (card: CardInput) => ({ char: modelName(card.doc) })

  // The speaker's card prompts, as ST's group generation takes them, expanded with the card's
  // fields ahead of everything else.
  const overrides = speaker
    ? {
        main: cardText(assembly, speaker, "system_prompt", own(speaker)),
        jailbreak: cardText(assembly, speaker, "post_history_instructions", own(speaker))
      }
    : null

  // Each card field is expanded once, whichever marker it goes to.
  const fields = new Map<string, Text>()
  const field = (card: CardInput, name: "description" | "personality" | "scenario") => {
    const key = `${card.entity}:${name}`
    const found = fields.get(key) ?? cardText(assembly, card, name, own(card))
    fields.set(key, found)
    return found
  }
  const definitions =
    presetOrder(doc.prompts, doc.order).some((e) => e.identifier === charDefinitions.identifier && e.enabled) &&
    doc.prompts.some(
      (p) =>
        p.identifier === charDefinitions.identifier &&
        triggersFor(p, cast.type) &&
        conditionHolds(assembly, conditionOf(p))
    )

  // ST's group join (getGroupCharacterCardsLazy): each character's trimmed field wrapped in the
  // preset's join prefix and suffix, with `{{char}}` that character and `<FIELDNAME>` the field,
  // empty fields skipped, joined with newlines in cast order, muted members included.
  const prefix = utility.card_join_prefix ?? CARD_JOIN_PREFIX
  const suffix = utility.card_join_suffix ?? CARD_JOIN_SUFFIX
  const wrap = (card: CardInput, label: string, id: string, body: ReadonlyArray<Text>): Text | null => {
    if (!body.some((part) => part.text)) return null
    const wrapper = (raw: string, which: string) => {
      const text = raw.replace(/<FIELDNAME>/gi, () => label)
      if (!text) return null
      // One piece per card and field, so each keeps its draws; the source is the utility prompt.
      const piece = env.piece(
        `preset:utility.card_join_${which}:${card.entity}:${id}`,
        presetSource(assembly, `utility.card_join_${which}`),
        text,
        { names: own(card) }
      )
      return { text: env.text(piece), piece }
    }
    const before = wrapper(prefix, "prefix")
    const after = wrapper(suffix, "suffix")
    const text = `${before?.text ?? ""}${body
      .filter((part) => part.text)
      .map((part) => part.text)
      .join("\n")}${after?.text ?? ""}`
    const parts = [before, ...body, after].flatMap((part) => (part ? [part.piece] : []))
    return {
      text,
      piece: env.verbatim(
        `card-part:${card.entity}:${id}`,
        { kind: "assembler", what: `${modelName(card.doc)}'s ${label.toLowerCase()}` },
        text,
        parts
      )
    }
  }
  const joinedLabels: Readonly<Record<string, string>> = {
    description: "descriptions",
    personality: "personalities",
    scenario: "scenarios"
  }
  const joined = (id: string, parts: ReadonlyArray<Text | null>, separator = "\n"): Text | null => {
    const present = parts.filter((part): part is Text => part !== null && part.text !== "")
    if (present.length === 0) return null
    const text = present.map((part) => part.text).join(separator)
    return {
      text,
      piece: env.verbatim(
        `cards:${id}`,
        {
          kind: "assembler",
          what:
            id === "personas"
              ? "Personas"
              : `The characters' ${joinedLabels[id.replace("macro:", "")] ?? "definitions"}`
        },
        text,
        present.map((part) => part.piece)
      )
    }
  }
  const labels = { description: "Description", personality: "Personality", scenario: "Scenario" } as const
  // What `{{description}}` and the others read in preset text: the joined fields, without notes.
  const joinedField = (name: keyof typeof labels) =>
    joined(
      `macro:${name}`,
      characters.map((card) => {
        const value = field(card, name)
        return value.text ? wrap(card, labels[name], `macro:${name}`, [value]) : null
      })
    )
  const macroFields = {
    description: joinedField("description"),
    personality: joinedField("personality"),
    scenario: joinedField("scenario")
  }
  env.setCard({
    ...macroCard(cast, assembly.notes),
    joined: {
      description: macroFields.description?.text ?? "",
      personality: macroFields.personality?.text ?? "",
      scenario: macroFields.scenario?.text ?? ""
    }
  })

  let markers: {
    definitions: Text | null
    description: Text | null
    personality: Text | null
    scenario: Text | null
    persona: Text | null
  }
  if (definitions) {
    // The whole-card marker: each character in its labelled block, then each persona.
    const memo = (assembly: Assembly, card: CardInput, name: keyof CardInput["doc"], names?: Partial<Names>) =>
      name === "description" || name === "personality" || name === "scenario"
        ? cast.personas.includes(card)
          ? cardText(assembly, card, name, names)
          : field(card, name)
        : cardText(assembly, card, name, names)
    markers = {
      definitions: joined(
        "definitions",
        [
          ...characters.map((card) => cardBlock(assembly, card, memo, wrap, cardNotes(assembly, card, card))),
          ...cast.personas.map((card) => personaBlock(assembly, card, memo, wrap, cardNotes(assembly, card, null)))
        ],
        "\n\n"
      ),
      description: null,
      personality: null,
      scenario: null,
      persona: null
    }
  } else {
    const perField = (name: keyof typeof labels) =>
      joined(
        name,
        characters.map((card) => {
          const value = field(card, name)
          // Notes placed with the definitions go at the top of their card's part.
          const notes = name === "description" ? cardNotes(assembly, card, card) : []
          return wrap(card, labels[name], name, [...notes, ...(value.text ? [value] : [])])
        })
      )
    // A field with a format is the format expanded, which reads the joined field: ST's
    // scenario_format and personality_format.
    const formatted = (text: Text | null, format: string, id: string) =>
      text && format ? presetText(assembly, id, format) : text
    const persona = (card: CardInput) =>
      withCardNotes(
        assembly,
        card,
        null,
        card.doc.description
          ? (() => {
              const piece = env.piece(
                `card:${card.entity}:description`,
                cardSource(assembly, card, "description"),
                card.doc.description
              )
              return cardNewlines(assembly, piece)
            })()
          : null
      )
    markers = {
      definitions: null,
      description: perField("description"),
      personality: formatted(perField("personality"), utility.personality_format, "utility.personality_format"),
      scenario: formatted(perField("scenario"), utility.scenario_format, "utility.scenario_format"),
      // The persona is a cast card: each wrapped like the characters' parts, one or several (DESIGN §5.0).
      persona: joined(
        "personas",
        cast.personas.map((card) => {
          const text = persona(card)
          return text ? wrap(card, "Persona", "persona", [text]) : null
        })
      )
    }
  }
  // Examples keep their own handling: parsed per card into example chats, named in a group.
  const examples0 = characters.flatMap((card) =>
    group ? exampleLines(assembly, card, modelName(card.doc), true) : exampleLines(assembly, card, names.char, false)
  )
  let examples: Array<Array<ChatLine>> = examples0
  const pendingNotes = placedNotes(assembly, characters, cast.personas)
  const newChat = group
    ? optional("utility.new_group_chat_prompt", utility.new_group_chat_prompt)
    : optional("utility.new_chat_prompt", utility.new_chat_prompt)

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
  const belowHistory = mode.loreBelowHistory
  // With "only below the history" off, entries go where their position says, as ST places them.
  let positioned = belowHistory ? [] : lore.toReversed()
  const historyAt = collection.findIndex((p) => p.identifier === "chatHistory")
  // A marker the order lacks is appended after everything, so it's never above the history.
  const aboveHistory = (identifier: string) => {
    const at = collection.findIndex((p) => p.identifier === identifier)
    return at >= 0 && historyAt >= 0 && at < historyAt
  }
  const pinnable = (position: string) =>
    !belowHistory &&
    (position === "before_char"
      ? aboveHistory("worldInfoBefore")
      : position === "after_char"
        ? aboveHistory("worldInfoAfter")
        : (position === "em_top" || position === "em_bottom") && aboveHistory("dialogueExamples"))
  const placeLore = () => {
    for (const [identifier, position, id] of [
      ["worldInfoBefore", "before_char", "before"],
      ["worldInfoAfter", "after_char", "after"]
    ] as const) {
      place(
        collection,
        identifier,
        "system",
        loreBlock(
          id,
          positioned.filter((e) => e.entry.position === position),
          true
        )
      )
      if (pinnable(position)) {
        const at = collection.findIndex((p) => p.identifier === identifier)
        collection[at] = { ...collection[at]!, kind: "pinned" }
      }
    }
    const loreExamples = (position: "em_top" | "em_bottom") =>
      (position === "em_top" ? positioned.toReversed() : positioned)
        .filter((e) => e.entry.position === position)
        .flatMap((e) =>
          exampleBlocks(cardNewlines(assembly, e.piece).text).map((block) =>
            parseExampleBlock(block, names.user, names.char, false).map((line): ChatLine => ({
              role: "system",
              content: line.content,
              name: line.name,
              pieces: [e.piece],
              kind: pinnable(position) ? "pinned" : "volatile"
            }))
          )
        )
    examples = doc.strip_examples ? [] : [...loreExamples("em_top"), ...examples0, ...loreExamples("em_bottom")]
  }
  placeLore()
  for (const e of positioned.filter((e) => e.entry.position === "outlet"))
    assembly.issues.push({
      kind: "lorebook_issue",
      message: `Lorebook outlet ${e.entry.outlet_name} has no prompt outlet; entry ${e.entry.uid} was not placed.`
    })
  // Below the history: every activated entry, whatever its position, in one block at the start of
  // the tail, re-evaluated every turn.
  const tailLore = belowHistory ? loreBlock("tail", lore) : null
  const loreCost = tokensOf({ content: tailLore?.text ?? "" })
  // When the order has both, Definitions wins and the per-field markers stay empty.
  if (definitions) place(collection, "charDefinitions", "system", markers.definitions)
  place(collection, "charDescription", "system", markers.description)
  place(collection, "charPersonality", "system", markers.personality)
  place(collection, "scenario", "system", markers.scenario)
  place(collection, "quietPrompt", "system", null)
  place(collection, "bias", "assistant", null)
  if (markers.persona) place(collection, "personaDescription", "system", markers.persona)
  if (overrides && speaker) {
    assembly.cardOverrides = []
    override(assembly, collection, disabled, "main", overrides.main, speaker)
    override(assembly, collection, disabled, "jailbreak", overrides.jailbreak, speaker)
  }

  const previous = previousStart(assembly)
  const configuration = configurationOf(assembly)
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
      positioned.filter((e) => e.entry.position === "an_top")
    )
  const loreBottom = () =>
    loreBlock(
      "an-bottom",
      positioned.filter((e) => e.entry.position === "an_bottom")
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
  // Lore on the author's note is never pinned: out of the chat, the note changes whenever an
  // entry that can ride on it comes or goes, so it is volatile even on a turn with none.
  const authorLore = need(assembly, "lorebooks").some((b) =>
    b.doc.entries.some((e) => e.enabled && (e.position === "an_top" || e.position === "an_bottom"))
  )
  const notes = pendingNotes.placed.flatMap(({ text, place, id, baseline, rank, author }) => {
    const expanded = text()
    if (!expanded) return []
    const riding = author && authorLore && !belowHistory && place.at !== "chat"
    return [
      {
        text: author ? around(expanded) : expanded,
        place: riding ? { ...place, volatile: true } : place,
        id,
        baseline,
        rank
      }
    ]
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
  const groupNames = group
  const projected = need(assembly, "projected")
  // The history stage ran the scripts on the verbatim messages it read; templates run here.
  const read = need(assembly, "scripted")
  const scripted: Array<
    { readonly text: string; readonly volatile: boolean; readonly applied?: ReadonlyArray<ScriptRef> } | undefined
  > = projected.map((p, i) =>
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
  // The inspector names the scripts that changed a message beside its source.
  scripted.forEach((result, i) => {
    if (result?.applied?.length) assembly.pieces[projected[i]!.piece]!.scripts = result.applied
  })
  // Notes in-chat are extension prompts at their depth; the others go beside the main prompt,
  // one after another (injectToMain).
  // Lore above the history is pinned: what follows the first place it can go is stable only
  // until the history's start moves, even on a turn with no entry there.
  const slots = [
    ["worldInfoBefore", "before_char"],
    ["worldInfoAfter", "after_char"],
    ["dialogueExamples", "em_top"],
    ["dialogueExamples", "em_bottom"]
  ] as const
  const filled = new Set(
    need(assembly, "lorebooks").flatMap((b) => b.doc.entries.flatMap((e) => (e.enabled ? [e.position] : [])))
  )
  const boundary = Math.min(
    ...slots.flatMap(([identifier, position]) =>
      filled.has(position) && pinnable(position) ? [collection.findIndex((p) => p.identifier === identifier)] : []
    )
  )
  if (Number.isFinite(boundary))
    collection.splice(boundary, 0, {
      ...collection[boundary]!,
      identifier: "lore-pinned-boundary",
      content: "",
      piece: null,
      system_prompt: false,
      injection_position: "relative",
      kind: "pinned",
      barrier: true
    })
  const placement = (placed: typeof notes) => {
    const collection = [...baseCollection]
    const layer: Array<StMessage> = []
    const injections: Array<Injection> = placed.flatMap(({ text, place }) =>
      place.at === "chat" ? [{ depth: place.depth, role: place.role, text }] : []
    )
    for (const e of positioned.filter((e) => e.entry.position === "at_depth"))
      injections.push({
        depth: Math.max(0, Math.min(10000, e.entry.depth)),
        role: e.entry.role,
        text: { text: env.text(e.piece), piece: e.piece }
      })
    const beside: Array<{ readonly message: StMessage; readonly at: "start" | "end" }> = []
    // Notes already put at a slot's start, so the next one follows them and the notes keep their order.
    const before = { context_start: 0, tail_start: 0 }
    for (const { text, place, id } of placed) {
      if (place.at === "chat") continue
      if (place.at === "context_start" || place.at === "tail_start" || place.at === "tail_end") {
        const history = collection.findIndex((p) => p.identifier === "chatHistory")
        const tail =
          history < 0 ? collection.length : history + (collection[history + 1]?.identifier === "newestMessage" ? 2 : 1)
        const newest = collection.findIndex((p) => p.identifier === "newestMessage")
        const tailEnd = newest > history + 1 ? newest : collection.length
        const index =
          place.at === "context_start"
            ? before.context_start++
            : place.at === "tail_start"
              ? tail + before.tail_start++
              : tailEnd
        collection.splice(index, 0, {
          identifier: `note:${id}`,
          role: place.role,
          content: text.text,
          piece: text.piece,
          system_prompt: false,
          injection_position: "relative",
          injection_depth: 0,
          injection_order: 100,
          forbid_overrides: true,
          kind: place.at === "context_start" && !place.volatile ? "prefix" : "volatile",
          barrier: place.volatile && !text.text
        })
        continue
      }
      const main = collection.findIndex((p) => p.identifier === "main")
      const mainPrompt = collection[main]!
      if (mainPrompt.injection_position === "absolute") {
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
      } else {
        const kind = place.volatile ? "volatile" : "prefix"
        beside.push({ message: { role: place.role, content: text.text, pieces: [text.piece], kind }, at: place.at })
      }
    }
    if (belowHistory) {
      // The lore block opens the tail, before its notes; empty, it still bounds the cache.
      const history = collection.findIndex((p) => p.identifier === "chatHistory")
      const tail =
        history < 0 ? collection.length : history + (collection[history + 1]?.identifier === "newestMessage" ? 2 : 1)
      collection.splice(tail, 0, {
        identifier: "lore:tail",
        role: "system",
        content: tailLore?.text ?? "",
        piece: tailLore?.piece ?? null,
        system_prompt: false,
        injection_position: "relative",
        injection_depth: 0,
        injection_order: 100,
        forbid_overrides: true,
        kind: "volatile",
        barrier: true
      })
    }
    // Each summary is its own message just before the history, oldest first, as the history's
    // messages are: a new summary leaves the earlier ones' cached prefix as it was (DESIGN §8).
    assembly.lcm?.summaries.forEach((summary, i) => {
      if (summary.content === "") return
      // Its own piece around the summary's text, so the inspector titles the turn as a group.
      const content = summaryBlock(summary)
      const block = need(assembly, "macros").verbatim(
        `layout:summary:${summary.firstSlotId}:${summary.lastSlotId}`,
        { kind: "assembler", what: `Summary of messages ${summary.from}–${summary.to}` },
        content,
        [assembly.lcmPieces![i]!]
      )
      layer.push({ role: "system", content, pieces: [block], kind: "summary" })
    })
    const layerCost = layer.reduce((n, message) => n + tokensOf(message), 0)
    return { collection, beside, injections, layer, layerCost }
  }
  for (const prompt of collection) {
    if (prompt.piece !== null) assembly.pieces[prompt.piece]!.marker = prompt.identifier
  }
  const baseCollection = collection
  let actualPlacement = placement(notes)
  let reservedPlacement = actualPlacement
  const lines = projected.map((p, i) => chatLine(assembly, p, groupNames, scripted[i]!))
  // The registered end stage owns the renderer. Expand after prompts/notes so its reads see
  // their writes, and its writes cannot change the prefix. Prefill may read its writes next.
  if (assembly.renderEndOfRequest) {
    const end = assembly.renderEndOfRequest()
    if (end) assembly.endOfRequest = end
    else delete assembly.endOfRequest
  }
  prefill(assembly)
  const newExampleChat = optional("utility.new_example_chat_prompt", utility.new_example_chat_prompt)
  const schemaReserve =
    assembly.prefill && assembly.model?.prefill === "tool_schema" ? schemaPrefillBudget(assembly.prefill) : null
  const prefillInput =
    schemaReserve?.input ??
    (assembly.prefill
      ? tokensOf({ content: assembly.prefill })
      : assembly.continuation
        ? tokensOf({ content: assembly.continuation.text })
        : 0)
  const prefixOutput = schemaReserve?.output ?? 0
  // A default response length gives way to the source prefix; only the model's own can exceed the limit.
  const outputLimit = assembly.model?.maxOutput
  if (
    schemaReserve &&
    outputLimit != null &&
    assembly.model?.settings?.samplers?.openai_max_tokens === undefined &&
    outputLimit - prefixOutput > 0 &&
    doc.samplers.openai_max_tokens + prefixOutput > outputLimit
  ) {
    doc = { ...doc, samplers: { ...doc.samplers, openai_max_tokens: outputLimit - prefixOutput } }
    assembly.preset = { ...need(assembly, "preset"), doc }
  }
  if (schemaReserve && doc.samplers.openai_max_tokens + prefixOutput > (assembly.model?.maxOutput ?? Infinity))
    throw new AssemblyFailed({
      reason: "budget",
      message: `The source prefix and requested continuation need about ${doc.samplers.openai_max_tokens + prefixOutput} output tokens, beyond ${assembly.model!.key}'s ${assembly.model!.maxOutput}-token output limit. Choose a model with a larger output limit or reduce the model's response length.`
    })
  // The end-of-request message `messages` sends last (DESIGN §2.2) is budgeted here, so it never
  // takes the request past its target; without one, so is the fallback that may replace it.
  const endOfRequest = assembly.endOfRequest
    ? tokensOf(assembly.endOfRequest)
    : !assembly.request.summarizing && !assembly.prefill
      ? tokensOf({
          content: assembly.continuation
            ? CONTINUE_TEXT
            : FALLBACK_TEXT.replace("{{speaker}}", cast.speaker ? modelName(cast.speaker.doc) : names.char)
        })
      : 0
  const reserve =
    endOfRequest +
    prefillInput +
    prefixOutput +
    (belowHistory && assembly.lorebooks?.length ? loreAllowance(assembly) - loreCost : 0)
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
      stableExamples: assembly.lcm !== undefined || doc.pin_examples === true,
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
      budget
    })
  }
  const postNames = {
    user: names.user,
    char: names.char,
    group: cast.characters.length > 1 ? cast.characters.map((c) => modelName(c.doc)) : []
  }
  const cost = (built: ReturnType<typeof compose>) => {
    const messages = built.messages.filter((message) => message.content)
    const processed = postProcess(doc.squash ? squash(messages) : messages, doc.postprocess, postNames)
    const tokens = (messages: ReadonlyArray<StMessage>) =>
      limitImageEstimates(messages, assembly.model?.maxImages ?? DEFAULT_MAX_IMAGES).reduce(
        (sum, message) => sum + tokensOf(message),
        0
      )
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
  // The pairs (DESIGN §8). When both maxima don't fit beside the fixed part and the reply, both
  // pairs are scaled down by one factor, keeping their proportions; the total limit always wins.
  const settings = assembly.lcm ? (assembly.lcmSettings ?? resolveLcm(need(assembly, "state").lcm, null)) : null
  const room = Math.max(0, contextBudget(assembly) - (fixedCost - actualPlacement.layerCost))
  const scale = settings ? Math.min(1, room / Math.max(1, settings.recentMax + settings.layerMax)) : 1
  const layerPair = settings
    ? fitPair(Math.floor(settings.layerTarget * scale), Math.floor(settings.layerMax * scale), contextBudget(assembly))
    : null
  const layerReserve = layerPair
    ? Math.max(0, Math.min(maximum - fixedCost, layerPair.target - actualPlacement.layerCost))
    : 0
  if (layerPair) assembly.lcmBudget = { target: layerPair.target, maximum: layerPair.maximum }
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
    // Unpinned examples use only the room left by history. At a cut, keep the
    // normal stepped target; between cuts the admitted examples stay stable.
    let history = projected.length
    let limit = maximum
    if (!doc.pin_examples) {
      if (budgetCost(0, false, false) > maximum) limit = desiredTarget
      let low = 0,
        high = projected.length
      while (low < high) {
        const mid = Math.floor((low + high) / 2)
        if (budgetCost(mid, false, false) <= limit) high = mid
        else low = mid + 1
      }
      history = low
    }
    let low = 0,
      high = examples.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      admittedExamples = examples.slice(0, mid)
      if (budgetCost(history, true, false) <= limit) low = mid
      else high = mid - 1
    }
    admittedExamples = examples.slice(0, low)
  }
  if (configurationChanged || noteBudgetChanged) admit()
  else admittedExamples = examples.slice(0, prior.examples)
  const minimum = budgetCost(projected.length, true, false)
  // With LCM on, recent messages kept as written have their own pair (DESIGN §8): stepped history
  // holds until they pass its maximum, then cuts toward its target. The pair is scaled down whole
  // when the history allowance is smaller; the total limit always wins.
  const recentPair = settings
    ? fitPair(
        Math.floor(settings.recentTarget * scale),
        Math.floor(settings.recentMax * scale),
        Math.max(0, maximum - minimum)
      )
    : null
  // The history allowance before the recent pair caps it: fresh failed ranges stay raw within it.
  const windowMaximum = maximum
  // A summary request is cut at its chunk's end and needs the whole chunk: only the window bounds it.
  if (recentPair && !assembly.request.summarizing) {
    maximum = Math.min(maximum, minimum + recentPair.maximum)
    desiredTarget = Math.min(desiredTarget, minimum + recentPair.target)
    assembly.lcmRecent = { target: recentPair.target, maximum: recentPair.maximum }
  }
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
    // Moving Newest before History can make removing an older image admit a more
    // expensive newest image at the cap. Those suffix costs need not be monotonic.
    const order = actualPlacement.collection
    const newest = order.findIndex((prompt) => prompt.identifier === "newestMessage")
    const history = order.findIndex((prompt) => prompt.identifier === "chatHistory")
    if (newest >= 0 && newest < history && !disabled("newestMessage") && lines.some((line) => line.images?.length)) {
      for (let start = 0; start < end; start++) if (fits(start, target)) return start
      return end
    }
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
  // The recent pair cuts only messages that can be summarized: fresh failed leaf ranges beyond the
  // cursor remain raw while the window fits (§16), the earliest first. A start at a range's first
  // message keeps that range and every later one raw, and turns no other range into a marker.
  if (maximum < windowMaximum) {
    const kept = failuresBefore(normalizedStart(start))
      .map((failure) => projected.findIndex((p) => p.entry.depth + 1 >= failure.from))
      .find((from) => from >= 0 && fits(from, windowMaximum))
    if (kept !== undefined) {
      start = kept
      budget = windowMaximum
    }
  }
  start = normalizedStart(start)
  // A summary must see its whole declared range, including its images; partial input
  // would permanently replace unseen material with a summary that never described it.
  if (assembly.request.summarizing && start > 0) {
    const images = lines.flatMap((line) => line.images ?? []).filter((image) => image.estimate?.sent !== false)
    const tokens = images.reduce((sum, image) => sum + budgetTokens(image.estimate), 0)
    throw new AssemblyFailed({
      reason: "budget",
      message: `The summary chunk cannot fit the history limit of ${Math.max(0, budget - minimum).toLocaleString("en-US")} tokens${images.length ? `; its images need about ${tokens.toLocaleString("en-US")} tokens` : ""}. Reduce the chunk or increase the context target.`
    })
  }
  // Never send a reply after cutting away the very turn it should answer.
  if (
    projected.length > 0 &&
    start >= projected.length &&
    !assembly.request.summarizing &&
    budgetCost(projected.length - 1) > budget
  ) {
    const newest = lines.at(-1)!
    const images = (newest.images ?? []).filter((image) => image.estimate?.sent !== false)
    const imageTokens = images.reduce((sum, image) => sum + budgetTokens(image.estimate), 0)
    const limit = Math.max(0, budget - minimum)
    throw new AssemblyFailed({
      reason: "budget",
      message: images.length
        ? `The newest message's ${images.length === 1 ? "image needs" : "images need"} about ${imageTokens.toLocaleString("en-US")} tokens; the history limit is ${limit.toLocaleString("en-US")} tokens. Reduce the images or increase the context target.`
        : `The newest message needs about ${tokensOf(newest).toLocaleString("en-US")} tokens; the history limit is ${limit.toLocaleString("en-US")} tokens. Shorten it or increase the context target.`,
      contextBudget: contextBudgetInfo(fixedCost),
      preset: { ref: need(assembly, "preset").ref, scope: need(assembly, "preset").scope }
    })
  }
  const first = projected[start]?.entry
  const startDepth = first?.depth ?? need(assembly, "target").depth
  // Pins hold while the history's start does: when it moves (a cut, a restore, LCM's cursor),
  // entries kept only by their pin go, and what matched this turn is pinned in their place.
  const released = lore.filter((e) => e.pinnedOnly)
  if (released.length && (!previous || previous.depth !== startDepth || assembly.historyMove !== "unchanged")) {
    const gone = new Set(released.map((e) => e.piece))
    positioned = positioned.filter((e) => !gone.has(e.piece))
    placeLore()
    admittedExamples = admittedExamples.filter((block) => !block.some((line) => line.pieces.some((p) => gone.has(p))))
    actualPlacement = placement(notes)
    for (const piece of gone) {
      const record = assembly.pieces[piece]!
      if (record.source.kind === "lorebook")
        assembly.pieces[piece] = {
          ...record,
          text: "",
          source: {
            ...record.source,
            activation: { status: "skipped", step: 0, reason: "pin released: the history's start moved" }
          }
        }
    }
  }
  const pinnedLore = positioned.flatMap((e) =>
    pinnable(e.entry.position) ? [{ book: e.book, revision: e.revision, uid: e.entry.uid }] : []
  )
  assembly.contextBudget = contextBudgetInfo(cost(candidate(start, Number.POSITIVE_INFINITY, true, false, true, true)))
  assembly.historyStart = {
    slotId: first?.slotId ?? null,
    depth: startDepth,
    state: {
      configuration,
      identity,
      maximum: contextBudget(assembly),
      target: targetBudget(assembly),
      examples: admittedExamples.length,
      noteBudget: { sizes, allowance },
      revision: assembly.historyRevision ?? 0,
      ...(belowHistory ? {} : { pinnedLore })
    }
  }
  // The outer cut already admits the whole image-aware candidate in final request order.
  // ST's inner chronological cut cannot repeat that decision when Newest message moves:
  // the image it would charge can be the one dispatch leaves out by the last-N limit.
  const imageHistory = lines.some((line) => line.images?.length)
  const admitted = candidate(start, imageHistory ? Number.POSITIVE_INFINITY : budget)
  if (imageHistory && cost(admitted) > budget)
    throw new AssemblyFailed({
      reason: "budget",
      message: `The image-bearing history needs about ${cost(admitted).toLocaleString("en-US")} tokens; the context input limit is ${budget.toLocaleString("en-US")} tokens. Reduce the images or increase the context target.`
    })
  const composition = {
    ...admitted,
    historyBudget:
      candidate(projected.length, maximum, true, false, false).historyBudget -
      failuresBefore(start).reduce((n, failure) => n + tokensOf({ content: assembly.pieces[failure.piece]!.text }), 0),
    examplesTotal: examples.length
  }
  assembly.postNames = postNames
  assembly.composition = composition
  if (recentPair && layerPair)
    assembly.lcmMeasure = {
      context: contextBudget(assembly) + doc.samplers.openai_max_tokens,
      fixed: Math.max(0, minimum - actualPlacement.layerCost),
      reply: doc.samplers.openai_max_tokens + prefixOutput,
      recentNow: Math.max(0, budgetCost(start) - minimum),
      layerNow: actualPlacement.layerCost,
      recentClamped: scale < 1 || recentPair.clamped,
      layerClamped: scale < 1 || layerPair.clamped
    }
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

/**
 * The end-of-request instruction (DESIGN §2.2, owner 2026-10-29): one user message, the
 * request's last, with the speaker's turn text (when your card speaks if the speaker is one you
 * play, else when a character speaks; when you continue a reply, on a Continue the model can't
 * be prefilled for) and, when the version has a direction, the direction text
 * on a new line. Neither conditions nor ST's triggers apply to them. A summary request puts its
 * instruction there instead (`summary-request`), so it sends none. Expansion is deferred until
 * `compose` has prepared ordinary prompts and notes; `compose` budgets it and
 * `messages` sends it; without this stage the fallback alone applies.
 */
const endOfRequestStage = sync("end-of-request", (assembly) => {
  if (assembly.request.summarizing) return
  assembly.renderEndOfRequest = () => {
    const doc = need(assembly, "preset").doc
    const { speaker, personas } = need(assembly, "cast")
    const turn = continuesWithoutPrefill(assembly)
      ? CONTINUE_NUDGE
      : speaker !== null && personas.includes(speaker)
        ? IMPERSONATION_PROMPT
        : GROUP_NUDGE
    const direction = need(assembly, "target").direction?.trim() ? [DIRECTION_PROMPT] : []
    const parts = [turn, ...direction].flatMap((identifier) => {
      const content = doc.prompts.find((p) => p.identifier === identifier)?.content ?? ""
      if (content.trim() === "") return []
      const text = presetText(assembly, identifier, content)
      return text.text.trim() === "" ? [] : [text]
    })
    if (parts.length === 0) return
    return {
      role: "user",
      content: parts.map((t) => t.text).join("\n"),
      pieces: parts.map((t) => t.piece),
      kind: "volatile"
    }
  }
})

/** Squashing and post-processing, as ST does them before sending (ARCHITECTURE §15). */
const messagesStage = sync("messages", (assembly) => {
  const doc = need(assembly, "preset").doc
  // An empty skipped note still marks the next sent message as the potential boundary.
  let barrier = false
  // After the first place pinned lore can go, the prefix holds only until the history's start moves.
  let pinned = false
  let messages: Array<StMessage> = need(assembly, "composition").messages.map((message) => {
    if (message.kind === "volatile" || message.pieces.some(need(assembly, "macros").isVolatile)) barrier = true
    if (message.kind === "pinned") pinned = true
    const summary = message.pieces.some((p) => hasSummary(assembly, p))
    return {
      ...message,
      ...(barrier
        ? { kind: "volatile" as const }
        : pinned && message.kind !== "history"
          ? { kind: "pinned" as const }
          : summary
            ? { kind: "summary" as const }
            : {}),
      summary
    }
  })
  messages = messages.filter((m) => m.content)
  if (doc.squash) messages = squash(messages)
  messages = postProcess(messages, doc.postprocess, need(assembly, "postNames"))
  // DESIGN §2.2 requires one separate final user message, even in merging/single modes.
  const end = assembly.request.summarizing ? undefined : assembly.endOfRequest
  // Continue without a prefill (owner, 2026-10-31): the reply so far, the model's own message,
  // then the instruction to write only what follows it.
  const continuation = assembly.continuation
  if (continuation)
    messages.push({ role: "assistant", content: continuation.text, pieces: [continuation.piece], kind: "volatile" })
  if (end) messages.push({ ...end, kind: "volatile" })
  // The only fallback (DESIGN §2.2): without an end-of-request message, a request that would end
  // on an assistant message, with no prefill to continue it, asks for the speaker's message (or,
  // continuing, for the rest of it). Decided on the whole final request, including trailing system prompts.
  if (!end && !assembly.request.summarizing && !assembly.prefill && messages.at(-1)?.role === "assistant") {
    const env = need(assembly, "macros")
    const piece = continuation
      ? env.piece(
          "assembler:last-turn",
          { kind: "assembler", what: "end of request fallback: continue the reply" },
          CONTINUE_TEXT
        )
      : env.piece(
          "assembler:last-turn",
          { kind: "assembler", what: "end of request fallback: who writes next" },
          FALLBACK_TEXT
        )
    messages.push({ role: "user", content: env.text(piece), pieces: [piece], kind: "volatile" })
  }
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
  const imagesOf = messageImagesOf(assembly)
  if ((assembly.lcm?.summaries.some((s) => s.content !== "") || assembly.lcmFailures?.length) && firstSummary < 0)
    throw new AssemblyFailed({
      reason: "invalid_document",
      message: "This preset has no enabled placement for its summaries."
    })
  assembly.result = {
    ...(firstSummary >= 0 ? { summaryStart: firstSummary } : {}),
    messages: limitImageEstimates(
      messages.map(({ role, content, name, pieces }) => {
        // Images the fork took out are left out here, so every limit counts only what's sent.
        const images = imagesOf(pieces).map(({ image }) => image)
        return { role, content, ...(name ? { name } : {}), ...(images.length ? { images } : {}) }
      }),
      assembly.model?.maxImages ?? DEFAULT_MAX_IMAGES
    ),
    prefill: assembly.prefill ?? null,
    ...(assembly.continuation ? { continuation: { join: assembly.continuation.join } } : {}),
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
  const imageCount = assembly.result.messages.reduce((n, m) => n + (m.images?.length ?? 0), 0)
  if (imageCount && assembly.model?.vision === false)
    assembly.issues.push({
      kind: "images_unsupported",
      message: "This model cannot see images. Choose a vision model before replying."
    })
  if (imageCount > (assembly.model?.maxImages ?? DEFAULT_MAX_IMAGES))
    assembly.issues.push({
      kind: "images_limited",
      message: `Only the last ${assembly.model?.maxImages ?? DEFAULT_MAX_IMAGES} images will be sent.`
    })
  const mark = (piece: number, i: number) => {
    const record = assembly.pieces[piece]!
    if (!record.messages.includes(i)) record.messages.push(i)
    for (const part of record.parts ?? []) mark(part, i)
  }
  messages.forEach((message, i) => {
    for (const piece of message.pieces) mark(piece, i)
  })
})

/** Free explicit markers beside the one pi-ai puts on the last message (Anthropic's four, less it). */
const EXPLICIT_MARKERS = 3

const breakpointsStage = sync("breakpoints", (assembly) => {
  const previous = previousStart(assembly)
  const moved =
    previous !== null &&
    (assembly.historyMove !== "unchanged" || previous.depth !== need(assembly, "historyStart").depth)
  assembly.breakpoints = placeBreakpoints(
    need(assembly, "messages").map((m) => ({ ...m, summary: m.pieces.some((p) => hasSummary(assembly, p)) })),
    moved
  )
  // A provider that can't mark every boundary keeps the first ones; say which it can't keep.
  const dropped = assembly.breakpoints.slice(EXPLICIT_MARKERS)
  if (assembly.model?.cacheBreakpoints === "explicit" && dropped.length)
    assembly.issues.push({
      kind: "cache_breakpoints",
      message: `The provider takes ${EXPLICIT_MARKERS} cache markers here; ${dropped.map((b) => `"${b.reason}"`).join(", ")} isn't marked.`
    })
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
  replySectionsStage,
  resolveStage,
  imageTokensStage,
  rolesStage,
  noteGateStage,
  loreScanStage,
  loreActivationStage,
  endOfRequestStage,
  composeStage,
  messagesStage,
  breakpointsStage,
  requestStage,
  imagesStage
]

export const registerBuiltinStages = (registry: StageRegistry): Effect.Effect<void, never, Scope.Scope> =>
  Effect.forEach(builtinStages, (stage) => registry.register(stage), { discard: true })

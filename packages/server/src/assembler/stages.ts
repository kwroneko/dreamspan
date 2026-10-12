// The built-in assembler stages, in registration order (ARCHITECTURE §13 lists them).
import type { ChatMessage } from "@rp/shared/macros/context.ts"
import type { CardFields } from "@rp/shared/macros/context.ts"
import type { VariableEffect } from "@rp/shared/macros/variables.ts"
import { type ChatState, foldState } from "@rp/shared/state.ts"
import { Effect, type Scope } from "effect"
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

/** What the preset's budget allows: its context size, within the model's, less its response length. */
const contextBudget = (assembly: Assembly) => {
  const { samplers } = need(assembly, "preset").doc
  const model = assembly.model
  const context = Math.min(samplers.openai_max_context, model?.context ?? Number.POSITIVE_INFINITY)
  return context - samplers.openai_max_tokens
}

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
      return assembly
    })
}

const modelStage: AssemblerStage = {
  id: "model",
  run: (assembly) =>
    Effect.gen(function* () {
      const sources = yield* AssemblySources
      const bindings = need(assembly, "state").modelBindings
      assembly.model = yield* sources.model(bindings["narrator"] ?? bindings[""] ?? null)
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
        role: bindings["narrator"] ?? null,
        chat: bindings[""] ?? null,
        connection: assembly.model?.presetOverride ?? null
      })
      return assembly
    })
}

/**
 * Card-owned notes (DESIGN §4.1). A card's first note is ST's Character's Note, which ST
 * always sends, so it's on unless the chat turned it off; any other note is on once the
 * chat turns it on (`note.activate`).
 */
/** Whether each note the events turned on or off is on, as they last left it. */
const noteSwitches = (events: Iterable<PositionedEvent>) => {
  const last = new Map<string, boolean>()
  for (const { event } of events) {
    if (event.data.key === "note.activate") last.set(event.data.value.note, true)
    if (event.data.key === "note.deactivate") last.set(event.data.value.note, false)
  }
  return last
}

const activeNotes = (events: Iterable<PositionedEvent>, notes: ReadonlyArray<NoteInput>) => {
  const last = noteSwitches(events)
  return notes.filter((note) => last.get(note.entity) ?? note.first)
}

const notesStage: AssemblerStage = {
  id: "notes",
  run: (assembly) =>
    Effect.gen(function* () {
      const sources = yield* AssemblySources
      const state = need(assembly, "state")
      const cast = need(assembly, "cast")
      const notes = yield* sources.notes(
        cast.characters.map((c) => c.entity),
        state.noteRevisions
      )
      assembly.notes = activeNotes(need(assembly, "events"), notes)
      return assembly
    })
}

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
  const firstNote = notes?.find((n) => n.first && n.doc.owner.card === card?.entity)
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
    variables: need(assembly, "state").vars
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
      const budget = contextBudget(assembly)
      const scripted = new Map<string, Scripted>()
      let entries: ReadonlyArray<HistoryEntry> = []
      let leaf = target.parentSlotId
      let tokens = 0
      let depth = 0
      while (leaf !== null && tokens < budget) {
        const window = yield* sources.history(leaf, HISTORY_WINDOW)
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
          scripted.set(entry.versionId, { ...results[i]!, depth })
          tokens += tokensOf({ content: results[i]!.text })
        })
        leaf = window.older
      }
      assembly.history = entries
      assembly.historyOmitted = leaf === null ? 0 : (entries[0]?.depth ?? target.depth)
      assembly.scripted = scripted
      return assembly
    })
}

/** Where a template message is: the cast, names and card its macros saw there. */
interface Position {
  readonly cast: Cast
  readonly names: Names
  readonly card: CardFields
}

/** What decides a position's cast, names and card: equal keys share them. */
const positionKey = (state: ChatState, events: Iterable<PositionedEvent>) =>
  JSON.stringify([
    state.participants,
    state.playedByMe,
    state.absent,
    state.cardBindings,
    state.macroBindings,
    state.layoutCards,
    state.rolesProjection,
    state.noteRevisions,
    [...noteSwitches(events)]
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
 * was at their position and, the first time, hand back their writes (§13 "Macros by source").
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
  return { text: env.text(piece), piece }
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
      role: prompt.role,
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
  assembly.pieces[text.piece] = { ...record, text: content, parts: original.piece === null ? [] : [original.piece] }
  collection[at] = { ...original, content, piece: text.piece }
}

/**
 * The preset's assistant prefill (impersonation prefill when the user's character speaks):
 * sent where the model can be prefilled, and otherwise dropped and reported (DESIGN §1.2).
 */
const prefill = (assembly: Assembly) => {
  const doc = need(assembly, "preset").doc
  const type = need(assembly, "cast").type
  const raw = type === "impersonate" ? doc.prefill.impersonation : doc.prefill.assistant
  const id = type === "impersonate" ? "prefill.impersonation" : "prefill.assistant"
  const text = raw ? presetText(assembly, id, raw).text.trimEnd() : ""
  if (!text) return
  if (assembly.model?.prefill === "assistant") {
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
/** Characters of replacement text the scripts may make for one context. */
const REGEX_OUTPUT = 2_000_000
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

const noteInjections = (assembly: Assembly, cards: ReadonlyArray<CardInput>): Array<Injection> => {
  const env = need(assembly, "macros")
  return need(assembly, "notes")
    .filter((note) => cards.some((c) => c.entity === note.doc.owner.card))
    .sort((a, b) => (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0))
    .flatMap((note) => {
      const owner = cards.find((c) => c.entity === note.doc.owner.card)!
      const piece = env.piece(
        `note:${note.entity}`,
        { kind: "note", entity: note.entity, revision: note.revision },
        note.doc.content.trim(),
        { withoutCard: true, names: { char: owner.doc.name } }
      )
      const text = env.text(piece)
      return text ? [{ depth: note.doc.placement.depth, role: note.doc.placement.role, text: { text, piece } }] : []
    })
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
  let injections: Array<Injection>
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
      description: description.text ? description : null,
      personality: formatted(personality, utility.personality_format, "utility.personality_format"),
      scenario: formatted(scenario, utility.scenario_format, "utility.scenario_format"),
      persona:
        persona && persona.doc.description
          ? (() => {
              const piece = env.piece(
                `card:${persona.entity}:description`,
                cardSource(persona, "description"),
                persona.doc.description
              )
              return { text: env.text(piece), piece }
            })()
          : null
    }
    injections = noteInjections(assembly, [char])
    newChat = optional("utility.new_chat_prompt", utility.new_chat_prompt)
  } else {
    const blocks = (cards: ReadonlyArray<CardInput>, block: typeof cardBlock) =>
      cards.map((card) => block(assembly, card, cardText))
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
      persona: joined("personas", blocks(cast.personas, personaBlock))
    }
    const tailCards =
      mode.layout === "swap_tail" && cast.speaker && !cast.personas.includes(cast.speaker) ? [cast.speaker] : []
    examples = (mode.layout === "swap_tail" ? tailCards : cast.characters).flatMap((card) =>
      exampleLines(assembly, card, card.doc.name, true)
    )
    injections = noteInjections(assembly, mode.layout === "swap_tail" ? tailCards : cast.characters)
    newChat =
      cast.characters.length > 1
        ? optional("utility.new_group_chat_prompt", utility.new_group_chat_prompt)
        : optional("utility.new_chat_prompt", utility.new_chat_prompt)
    for (const card of tailCards) {
      const block = cardBlock(assembly, card, cardText)
      control.push({ role: "system", content: block.text, pieces: [block.piece], kind: "volatile" })
    }
    const said = directive(assembly, presetText)
    if (said) control.push({ role: "system", content: said.text, pieces: [said.piece], kind: "volatile" })
  }

  const collection = collectionOf(assembly)
  place(collection, "worldInfoBefore", "system", null)
  place(collection, "worldInfoAfter", "system", null)
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
  if (direction) {
    const piece = env.verbatim(
      "direction",
      { kind: "direction", version: need(assembly, "target").versionId },
      direction
    )
    control.push({ role: "system", content: direction, pieces: [piece], kind: "volatile" })
  }

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
  rest.forEach((index, i) => (scripted[index] = ran[i]))
  const chat = injectInChat(
    projected.map((p, i) => chatLine(assembly, p, groupNames, scripted[i]!)),
    collection.filter((p) => p.injection_position === "absolute"),
    injections
  )
  prefill(assembly)
  const composition = compose({
    collection,
    disabled,
    chat,
    examples,
    newChat,
    newExampleChat: optional("utility.new_example_chat_prompt", utility.new_example_chat_prompt),
    sendIfEmpty: optional("utility.send_if_empty", utility.send_if_empty),
    control,
    // The prefill is sent after everything else, but it's context all the same.
    budget: contextBudget(assembly) - (assembly.prefill ? tokensOf({ content: assembly.prefill }) : 0)
  })
  assembly.composition = composition
  if (composition.historySent < composition.historyTotal || (assembly.historyOmitted ?? 0) > 0) {
    assembly.issues.push({
      kind: "history_truncated",
      message: `The context holds the last ${composition.historySent} messages: older ones don't fit the preset's context size.`
    })
  }
  if (composition.examplesSent < composition.examplesTotal) {
    assembly.issues.push({
      kind: "examples_truncated",
      message: `${composition.examplesTotal - composition.examplesSent} example dialogues didn't fit the preset's context size.`
    })
  }
})

/** Squashing and post-processing, as ST does them before sending (ARCHITECTURE §13). */
const messagesStage = sync("messages", (assembly) => {
  const doc = need(assembly, "preset").doc
  const names = need(assembly, "macros").names
  const cast = need(assembly, "cast")
  let messages = [...need(assembly, "composition").messages]
  if (doc.squash) messages = squash(messages)
  messages = messages.filter((m) => m.content)
  assembly.postNames = {
    user: names.user,
    char: names.char,
    group: cast.characters.length > 1 ? cast.characters.map((c) => c.doc.name) : []
  }
  messages = postProcess(messages, doc.postprocess, assembly.postNames)
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
  assembly.result = {
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
  assembly.breakpoints = placeBreakpoints(need(assembly, "messages"))
})

const builtinStages: ReadonlyArray<AssemblerStage> = [
  pathStage,
  stateStage,
  castStage,
  modelStage,
  presetStage,
  notesStage,
  modeStage,
  macrosStage,
  scriptsStage,
  historyStage,
  resolveStage,
  rolesStage,
  composeStage,
  messagesStage,
  breakpointsStage,
  requestStage
]

export const registerBuiltinStages = (registry: StageRegistry): Effect.Effect<void, never, Scope.Scope> =>
  Effect.forEach(builtinStages, (stage) => registry.register(stage), { discard: true })

// The format worker's side of the ST data folder import (ARCHITECTURE.md §13): reading a
// chat part, settings.json, a group, or one of the folder's library files, and building a
// persona's card. Like every parse, nothing here throws on a file's content: a file that
// can't be read is a report with an error.
import { CardDoc } from "@rp/shared/docs/card.ts"
import { NOTE_SCHEMA_VERSION, noteDepth, type NoteDoc } from "@rp/shared/docs/note.ts"
import { ImportReport, ReportBuilder } from "@rp/shared/importReport.ts"
import type { EntityKind } from "@rp/shared/library.ts"
import { Context, Effect, Layer, Schema } from "effect"
import { makeRegistry, type Registry } from "../registry.ts"
import { attempt } from "../formats/safety.ts"
import { parseStChatPart, stChatLimits } from "../formats/stChat.ts"
import { parseStGroup, parseStSettings, personaCard, stRole } from "../formats/stData.ts"
import { failed, type Imported, parseFile, parsedFile, sha256 } from "./importers.ts"
import { ParsedFile, StChatPart, StGroup, type StPersona, StLibraryFile, StSettings } from "./ops.ts"

export const parseChatPart = (input: {
  readonly bytes: Uint8Array
  readonly first: boolean
  readonly firstIndex: number
  readonly carryAt: number | null
}) => {
  const issues = new ReportBuilder()
  return attempt(() => parseStChatPart(input.bytes, input, issues)).pipe(
    Effect.map((part) => new StChatPart({ ...part, report: issues.build("st-chat"), sha256: sha256(input.bytes) })),
    Effect.catchTag("FormatError", (error) =>
      Effect.succeed(unreadChatPart(input.bytes, input.carryAt, failed("st-chat", error.code, error.message)))
    )
  )
}

/** A chat part that gave nothing: only the report says why. */
export const unreadChatPart = (
  bytes: Uint8Array,
  carryAt: number | null,
  report = failed("st-chat", "st.parser_disabled", "The chat parser is disabled.")
) =>
  new StChatPart({
    report,
    sha256: sha256(bytes),
    header: null,
    batches: [],
    messages: 0,
    userTurns: 0,
    leadingHidden: 0,
    speakers: [],
    greeting: null,
    summaries: [],
    lastAt: carryAt
  })

const unreadFile = (bytes: Uint8Array, format: string) =>
  new ParsedFile({
    report: disabled(format),
    sha256: sha256(bytes),
    library: null,
    media: []
  })

export const unreadLibraryFile = (bytes: Uint8Array) =>
  new StLibraryFile({ parsed: unreadFile(bytes, "library-file"), card: null })

export const unreadPersona = (bytes: Uint8Array) => unreadFile(bytes, "persona")

const parseSettings = (bytes: Uint8Array) => {
  const issues = new ReportBuilder()
  return attempt(() => new StSettings(parseStSettings(bytes, issues))).pipe(
    Effect.map((settings) => ({ report: issues.build("st-settings"), settings })),
    Effect.catchTag("FormatError", (error) =>
      Effect.succeed({ report: failed("st-settings", error.code, error.message), settings: null })
    )
  )
}

const parseGroup = (bytes: Uint8Array, fileName: string) => {
  const issues = new ReportBuilder()
  return attempt(() => new StGroup(parseStGroup(bytes, fileName, issues))).pipe(
    Effect.map((group) => ({ report: issues.build("st-group"), group })),
    Effect.catchTag("FormatError", (error) =>
      Effect.succeed({ report: failed("st-group", error.code, error.message), group: null })
    )
  )
}

/** A card, World Info file or preset, refused when it isn't what its folder holds. */
const parseLibraryFile = (bytes: Uint8Array, fileName: string, expect: EntityKind) =>
  Effect.map(parseFile(bytes, fileName), (parsed) => {
    if (parsed.library !== null && parsed.library.kind !== expect) {
      return new StLibraryFile({
        parsed: {
          ...parsed,
          library: null,
          media: [],
          report: failed(parsed.report.format, "st.wrong_kind", `This is a ${parsed.library.kind}, not a ${expect}.`)
        },
        card: null
      })
    }
    if (parsed.library?.kind !== "card") return new StLibraryFile({ parsed, card: null })
    const card = Schema.decodeUnknownSync(CardDoc)(JSON.parse(parsed.library.docJson))
    const world = card.extensions.world
    return new StLibraryFile({
      parsed,
      card: {
        name: card.name,
        greetings: [card.first_mes, ...card.alternate_greetings, ...card.group_only_greetings]
          .filter((greeting) => greeting.trim() !== "")
          .map((greeting) => greeting.slice(0, stChatLimits.maxGreetingChars)),
        world: typeof world === "string" && world !== "" ? world : null,
        book: card.character_book !== undefined
      }
    })
  })

/**
 * Where ST put a persona's description (`persona_description_positions`) when not at the
 * prompt's persona description: an ordinary note on the persona's card at that place, which
 * then holds the only copy of the text (DESIGN §4.1, owner 2026-10-28). Null for the prompt's
 * persona description, where the card's description goes.
 */
const personaNote = (persona: StPersona): Omit<NoteDoc, "owner"> | null => {
  const placement: NoteDoc["placement"] | null =
    persona.position === 2
      ? { mode: "section", section: "author_note_top" }
      : persona.position === 3
        ? { mode: "section", section: "author_note_bottom" }
        : persona.position === 4
          ? { mode: "depth", depth: noteDepth(persona.depth), role: stRole(persona.role) }
          : persona.position === 9
            ? { mode: "none" }
            : null
  return (
    placement && {
      schema_version: NOTE_SCHEMA_VERSION,
      title: "Persona description",
      content: persona.description,
      placement,
      exportable: true,
      // ST sends it in every chat with the persona (DESIGN §4.1).
      on_by_default: true
    }
  )
}

export const buildPersona = (bytes: Uint8Array, fileName: string, persona: StPersona | null) => {
  const named: StPersona = persona ?? {
    avatar: fileName,
    name: fileName.replace(/\.[^.]*$/, ""),
    description: "",
    position: 0,
    depth: 2,
    role: 0
  }
  const note = personaNote(named)
  // One copy of the text: the note's, when ST placed it anywhere but the persona description.
  const doc = note ? { ...personaCard(named), description: "" } : personaCard(named)
  const imported: Imported = {
    report: new ImportReport({ format: "st-persona", issues: [] }),
    library: {
      kind: "card",
      label: named.name.trim() === "" ? "Unnamed persona" : named.name,
      doc,
      schemaVersion: doc.schema_version,
      note
    },
    files: [{ role: "avatar", uri: "ccdefault:", bytes }]
  }
  // The persona's settings count as its file too, so a re-import notices a changed description.
  const source = Buffer.concat([bytes, Buffer.from(JSON.stringify(persona))])
  return Effect.succeed(parsedFile(imported, sha256(source)))
}

/** The ST import's parsing steps, by the id their registry entries carry. */
export interface StParsers {
  /** One part of a chat file: its messages, mapped to the batches the writer stores. */
  readonly "chat-part": typeof parseChatPart
  readonly settings: typeof parseSettings
  readonly group: typeof parseGroup
  readonly "library-file": typeof parseLibraryFile
  readonly persona: typeof buildPersona
}

export type StParser = {
  readonly [K in keyof StParsers]: { readonly id: K; readonly run: StParsers[K] }
}[keyof StParsers]

/**
 * The ST import's parsers (PLUGINS §8), in the format worker beside the library importers:
 * what a chat part, settings.json, a group or a persona is read as. A plugin's parser
 * registers under the same id to replace or (`get` first) wrap one. It runs in the worker
 * like the built-ins, one request at a time, and returns the typed values the main thread
 * hands to the kernel's write operations; it never writes.
 */
export class StParserRegistry extends Context.Service<StParserRegistry, Registry<StParser>>()(
  "rp/importer/StParserRegistry"
) {}

export const layer = Layer.effect(
  StParserRegistry,
  Effect.gen(function* () {
    const registry = makeRegistry<StParser>()
    const builtins: ReadonlyArray<StParser> = [
      { id: "chat-part", run: parseChatPart },
      { id: "settings", run: parseSettings },
      { id: "group", run: parseGroup },
      { id: "library-file", run: parseLibraryFile },
      { id: "persona", run: buildPersona }
    ]
    for (const parser of builtins) yield* registry.register(parser)
    return registry
  })
)

/** The run function in effect for a parser id; undefined while it is disabled. */
export const stParser = <K extends keyof StParsers>(registry: Registry<StParser>, id: K) =>
  registry.get(id)?.run as StParsers[K] | undefined

/** A disabled parser reads nothing: the file is reported, not imported. */
export const disabled = (id: string) => failed(`st-${id}`, "st.parser_disabled", `The ${id} parser is disabled.`)

// The context assembler against ST (DESIGN §1.2, ARCHITECTURE §15): for each gate card's
// chat, each preset and each generation type, the request ST sends and the one we build for
// the settings ST had in force must be equal, apart from the documented differences.
import type { Browser } from "@playwright/test"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { NoteDoc } from "@rp/shared/docs/note.ts"
import { Effect } from "effect"
import { ReportBuilder } from "@rp/shared/importReport.ts"
import { parseStChatPart } from "../../src/formats/stChat.ts"
import { parseStSettings } from "../../src/formats/stData.ts"
import { chatStateChange } from "../../src/importer/stMapping.ts"
import { chatCompletionsFields } from "../../src/assembler/wire.ts"
import { importCard } from "../../src/formats/cardImport.ts"
import { importStPreset } from "../../src/formats/preset.ts"
import * as Importers from "../../src/importer/importers.ts"
import { json, png, run } from "../formats/support.ts"
import type { NoteInput } from "../../src/assembler/types.ts"
import { assembleFixture, type FixtureMessage } from "../support/assemblySources.ts"
import { gateLore } from "../support/loreFixtures.ts"
import type { FixtureSet } from "./fixtures.ts"
import { MOCK_MODEL, type MockEndpoint } from "./mock.ts"
import { diffJson, type Section } from "./report.ts"
import { buildPersona } from "../../src/importer/stParse.ts"
import { type AuthorNote, captureWithSettings, type PersonaPlacement, savePoisonPreset, type Summary } from "./st.ts"

/** What the user sends in every capture that sends something. */
const MESSAGE = "Is the crossing still possible tonight?"
const POISON = "st-diff poison"

/** The differences ARCHITECTURE §15 documents, each with the lines of the diff it explains. */
const DOCUMENTED: ReadonlyArray<{
  readonly why: string
  readonly matches: (line: string, config: Config, settings: Record<string, unknown>) => boolean
}> = [
  {
    why: "history leaves in steps down to the target (ST trims only to the maximum)",
    matches: (line, config) => config.overMaximum === true && line.startsWith("messages")
  },
  { why: "we always stream (ST sends the preset's stream_openai)", matches: (line) => line.startsWith("stream:") },
  {
    // Unit P1-1's owner question 3; ARCHITECTURE §15 "Conditions".
    why: "the group nudge is a prompt after the history, sent whenever the model writes as a character, one or many (ST: in group chats only)",
    matches: (line) =>
      line.startsWith("messages") &&
      /\[Write the next reply only as |speaks next\.\]|\[As [^\]]+ only\.\]|Write only [^"]+'s next reply/.test(line)
  },
  { why: "no multi-swipe requests (ST sends the preset's n above 1)", matches: (line) => line.startsWith("n:") },
  {
    why: "a note goes every turn (DESIGN §4.1): ST skips its author's note on the turns its frequency doesn't fall on, and never sends one at frequency 0 that a chat had on",
    matches: (line, config) =>
      config.authorNote !== undefined &&
      (config.authorNote.interval > 1 || config.activeAuthorNote === true) &&
      line.startsWith("messages")
  },
  {
    why: "what rides on an author's note imported off (frequency 0) still goes where it sits (owner question 6); ST sends none of it",
    matches: (line, config) =>
      config.authorNote !== undefined && config.authorNote.interval === 0 && line.startsWith("messages")
  },
  {
    why: "the preset's send_if_empty is expanded when it fills the user's turn (ST sends it as written before an impersonation)",
    matches: (line, config, settings) =>
      config.generate === "impersonate" &&
      /^messages\[\d+\]\.content: /.test(line) &&
      line.includes(`: ${JSON.stringify(settings.send_if_empty)} ≠ `)
  }
]

interface Config {
  readonly overMaximum?: boolean
  readonly lorebook?: boolean
  readonly name: string
  readonly presets: ReadonlyArray<string>
  readonly generate?: "impersonate" | "swipe"
  readonly empty?: boolean
  readonly postProcessing?: string
  readonly summary?: Summary
  readonly authorNote?: AuthorNote
  readonly defaultAuthorNote?: boolean
  /** An existing activated note edited to interval zero stays active in the chat state. */
  readonly activeAuthorNote?: boolean
  /** Where ST puts the persona's description, and whether it sends it there in this case. */
  readonly persona?: PersonaPlacement & { readonly sent: boolean }
}

/** The text of the fixture persona's description that ST's request must carry, or not. */
const PERSONA_TEXT = "is a cartographer who distrusts maps drawn by others"

/** A summary as ST's Summarize extension keeps it, its template naming the character too. */
const summary = (position: number, depth = 2, role = 0): Summary => ({
  text: "Tobin paid in favors; the fog came in early.",
  template: "[{{char}}'s story so far: {{summary}}]",
  position,
  depth,
  role
})

/** The note our ST import makes of it (importer/stMapping.ts). */
const summaryNote = (s: Summary): NoteInput => ({
  entity: "summary",
  revision: "summary-rev",
  doc: {
    schema_version: 1,
    title: "Summary",
    content: s.text,
    placement:
      s.position === 0
        ? { mode: "section", section: "after_main_prompt", role: (["system", "user", "assistant"] as const)[s.role]! }
        : s.position === 2
          ? {
              mode: "section",
              section: "before_main_prompt",
              role: (["system", "user", "assistant"] as const)[s.role]!
            }
          : { mode: "depth", depth: s.depth, role: (["system", "user", "assistant"] as const)[s.role]! },
    owner: { chat: "chat-1" as never },
    exportable: true,
    kind: "imported_summary",
    template: s.template
  }
})

/** An author's note naming both sides, at ST's position, depth and role, every `interval` messages. */
const authorNote = (position: number, depth: number, role: number, interval = 1): AuthorNote => ({
  text: "{{user}} is soaked through; {{char}} pretends not to notice.",
  position,
  depth,
  role,
  interval
})

/** The note our ST import makes of it (importer/stMapping.ts), and whether it turns it on. */
const authorNoteInput = (
  note: AuthorNote,
  defaults = false
): { readonly input: NoteInput; readonly activate: boolean } | null => {
  const issues = new ReportBuilder()
  const header = parseStChatPart(
    json({
      chat_metadata: defaults
        ? {}
        : {
            note_prompt: note.text,
            note_position: note.position,
            note_depth: note.depth,
            note_role: note.role,
            note_interval: note.interval
          }
    }),
    { first: true, firstIndex: 0, carryAt: null },
    issues
  ).header
  const settings = parseStSettings(
    json({
      extension_settings: {
        note: {
          allowWIScan: note.scan === true,
          ...(defaults
            ? {
                default: note.text,
                defaultPosition: note.position,
                defaultDepth: note.depth,
                defaultRole: note.role,
                defaultInterval: note.interval
              }
            : {})
        }
      }
    }),
    issues
  )
  const mapped = chatStateChange(
    { settings, cards: new Map(), personas: new Map(), personaNames: new Map(), worlds: new Map() },
    {
      header,
      link: { card: null, group: null },
      spoke: new Set(),
      summaries: [],
      messages: 2,
      run: { length: 0, firstSlot: null, throughSlot: null }
    },
    null,
    true
  ).notes.find((n) => n.kind === "author_note")
  return mapped
    ? {
        activate: mapped.activate,
        input: {
          entity: "author-note",
          revision: "author-note-rev",
          doc: {
            schema_version: 1,
            title: mapped.title,
            content: mapped.contents[0]!,
            placement: mapped.placement,
            owner: { chat: "chat-1" as never },
            exportable: true,
            kind: "author_note",
            ...(mapped.scanLore ? { scan_lore: true } : {})
          }
        }
      }
    : null
}

/** The note our ST import makes of the fixture persona placed there (importer/stParse.ts), or none in the prompt. */
const personaNoteInput = async (fixtures: FixtureSet, placement: PersonaPlacement): Promise<NoteInput | null> => {
  const avatar = "st-diff-persona.png"
  const parsed = await Effect.runPromise(
    buildPersona(png(), avatar, {
      avatar,
      name: fixtures.persona.name,
      description: fixtures.persona.description,
      ...placement
    })
  )
  const note = parsed.library?.noteDocJson
  return note
    ? {
        entity: "persona-note",
        revision: "persona-note-rev",
        doc: { ...(JSON.parse(note) as Omit<NoteDoc, "owner">), owner: { card: "persona" as never } }
      }
    : null
}

const activate = (note: string) => ({
  depth: null,
  event: { scope: null, data: { key: "note.activate" as const, value: { note: note as never } } }
})

const imported = async (png: Uint8Array, name: string) => {
  const parsed = await Effect.runPromise(Importers.parseFile(png, `${name}.png`).pipe(Effect.provide(Importers.layer)))
  const library = parsed.library!
  const doc = JSON.parse(library.docJson) as CardDoc
  const note = library.noteDocJson === null ? null : (JSON.parse(library.noteDocJson) as Omit<NoteDoc, "owner">)
  return { doc, note }
}

const ourRequest = async (
  fixtures: FixtureSet,
  character: string,
  config: Config,
  settings: Record<string, unknown>
): Promise<{ readonly body: unknown; readonly problem?: string }> => {
  const parsed = importStPreset(JSON.stringify(settings)).document
  if (parsed === null) return { body: null, problem: "our importer didn't take the settings ST had in force" }
  // The harness allows the fixture presets' regex scripts in ST, as a user would.
  // ST joins no wrapper around a single character's fields: the gate compares with them empty.
  const document = {
    ...parsed,
    regex_approved: true,
    utility_prompts: { ...parsed.utility_prompts, card_join_prefix: "", card_join_suffix: "" }
  }
  const card = await imported(fixtures.cards.find((c) => c.name === character)!.png, character)
  const persona = run(importCard(json({ name: fixtures.persona.name, description: fixtures.persona.description }))).card
  const importedAuthorNote = config.authorNote ? authorNoteInput(config.authorNote, config.defaultAuthorNote) : null
  const personaNote = config.persona ? await personaNoteInput(fixtures, config.persona) : null
  // The import keeps one copy of the text: with a note, the persona card's description is empty.
  const personaDoc = personaNote ? { ...persona, description: "" } : persona
  const lines: Array<FixtureMessage> = config.overMaximum
    ? Array.from({ length: 40 }, (_, i) => ({
        side: i % 2 ? "assistant" : "user",
        content: `Older turn ${i}: ${"road ".repeat(32)}`
      }))
    : fixtures.chats
        .find((c) => c.card === character)!
        .lines.map((line) => ({ side: line.is_user ? "user" : "assistant", content: line.mes }))
  // A swipe is a new version of the last reply: the context ends before it.
  const messages =
    config.generate === "swipe"
      ? lines.slice(0, -1)
      : config.generate
        ? lines
        : config.empty
          ? lines
          : [...lines, { side: "user" as const, content: MESSAGE }]
  const snapshot = await Effect.runPromise(
    assembleFixture({
      messages,
      target: {
        ...(config.generate === "impersonate" ? { speaker: "persona" } : {}),
        ...(config.generate === "swipe" ? { ordinal: 1 } : {})
      },
      cards: [
        { entity: "character", doc: card.doc },
        { entity: "persona", doc: personaDoc }
      ],
      participants: ["character"],
      persona: "persona",
      notes: [
        ...(card.note
          ? [
              {
                entity: "note",
                revision: "note-rev",
                doc: { ...card.note, owner: { card: "character" as never } }
              }
            ]
          : []),
        ...(personaNote ? [personaNote] : []),
        ...(config.summary ? [summaryNote(config.summary)] : []),
        ...(importedAuthorNote ? [importedAuthorNote.input] : [])
      ],
      lorebooks: config.lorebook
        ? [{ id: gateLore.id, entity: "gate-book", revision: "gate-rev", doc: gateLore.document }]
        : [],
      events: [
        ...(config.lorebook
          ? [
              {
                depth: null,
                event: { scope: null, data: { key: "lorebook.attach" as const, value: { ref: gateLore.id as never } } }
              },
              // Entries where their positions say, as ST places them.
              {
                depth: null,
                event: { scope: null, data: { key: "lorebook.below_history" as const, value: { on: false } } }
              }
            ]
          : []),
        ...(config.summary ? [activate("summary")] : []),
        // On as our import turns it on (text, and a frequency other than 0), or as a chat that
        // turned it on before keeps it.
        ...(importedAuthorNote && (config.activeAuthorNote || importedAuthorNote.activate)
          ? [activate("author-note")]
          : [])
      ],
      preset: document,
      model: {
        connectionId: "connection",
        modelId: "model",
        kind: "openai-chat",
        api: "openai-completions",
        key: MOCK_MODEL,
        prefill: "none",
        cacheBreakpoints: "auto",
        context: null,
        presetOverride: null
      }
    })
  )
  return { body: { model: MOCK_MODEL, stream: true, ...chatCompletionsFields(snapshot.request, "openai-chat") } }
}

/**
 * Each gate card's chat with ST's baseline settings, each fixture preset and the poison
 * preset; ST's post-processing modes; and ST's impersonate and swipe generations.
 */
export const compareAssembly = async (
  browser: Browser,
  url: string,
  mock: MockEndpoint,
  fixtures: FixtureSet
): Promise<ReadonlyArray<Section>> => {
  await savePoisonPreset(browser, url, POISON)
  const configs: ReadonlyArray<Config> = [
    { name: "baseline", presets: [] },
    { name: "history over maximum, stepped target", presets: ["default"], overMaximum: true },
    ...["default", "full"].map((preset) => ({
      name: `${preset}, lorebook positions`,
      presets: [preset],
      lorebook: true,
      authorNote: authorNote(1, 1, 1)
    })),
    ...fixtures.presetRoundTrips.map((preset) => ({ name: preset.name, presets: [preset.name] })),
    { name: "poison", presets: [POISON] },
    ...["merge", "semi", "strict", "single"].map((mode) => ({
      name: `full, ${mode} post-processing`,
      presets: ["full"],
      postProcessing: mode
    })),
    // ST's Summarize extension: after the main prompt, before it, and in-chat beside
    // the Character's Note, in the user's role.
    { name: "default, summary after main", presets: ["default"], summary: summary(0) },
    { name: "default, summary before main", presets: ["default"], summary: summary(2) },
    { name: "default, summary in-chat", presets: ["default"], summary: summary(1, 1, 1) },
    // The author's note (authors-note.js): in-chat beside the Character's Note, in the user's
    // role; after the main prompt; before it, with the summary there too; and every second
    // message of the user's, which one card's chat reaches with the message sent and the
    // other's doesn't.
    { name: "default, author's note in-chat", presets: ["default"], authorNote: authorNote(1, 1, 1) },
    // ST's "Include in World Info Scanning": an entry keyed only on the author's note's text.
    {
      name: "default, author's note scanned for lore",
      presets: ["default"],
      lorebook: true,
      authorNote: { ...authorNote(1, 1, 1), scan: true }
    },
    { name: "default, author's note after main", presets: ["default"], authorNote: authorNote(0, 4, 0) },
    {
      name: "default, author's note and summary before main",
      presets: ["default"],
      summary: summary(2),
      authorNote: authorNote(2, 4, 0)
    },
    { name: "default, author's note every 2nd message", presets: ["default"], authorNote: authorNote(1, 0, 0, 2) },
    {
      name: "full, empty send counts toward interval 2",
      presets: ["full"],
      authorNote: authorNote(1, 0, 0, 2),
      empty: true
    },
    { name: "default, author's note after main as user", presets: ["default"], authorNote: authorNote(0, 4, 1) },
    { name: "default, author's note before main as assistant", presets: ["default"], authorNote: authorNote(2, 4, 2) },
    {
      name: "default, impersonate interval 2",
      presets: ["default"],
      authorNote: authorNote(1, 0, 0, 2),
      generate: "impersonate"
    },
    { name: "default, skipped after main as user", presets: ["default"], authorNote: authorNote(0, 4, 1, 99) },
    {
      name: "default, summary writes the author's variable",
      presets: ["default"],
      summary: { ...summary(0), template: "{{setvar::x::SUM}}{{summary}}" },
      authorNote: { ...authorNote(1, 0, 0), text: "{{getvar::x}} is soaked through; {{char}} pretends not to notice." }
    },
    {
      name: "full, skipped section as user with squash",
      presets: ["full"],
      postProcessing: "none",
      authorNote: authorNote(0, 4, 1, 99)
    },
    {
      name: "full, skipped depth-zero note before impersonation filler",
      presets: ["full"],
      postProcessing: "none",
      authorNote: authorNote(1, 0, 0, 99),
      generate: "impersonate"
    },
    // The persona's description placed at the author's note's top or bottom (personas.js):
    // it joins the note's text, and goes where the note goes or with ST's default note, in-chat
    // at depth 4, when the chat has none; it goes nowhere when the note is off or not due.
    ...(
      [
        ["top", 2],
        ["bottom", 3]
      ] as const
    ).flatMap(([where, position]) => [
      {
        name: `default, persona at the ${where} of the author's note`,
        presets: ["default"],
        authorNote: authorNote(1, 1, 1),
        persona: { position, depth: 2, role: 0, sent: true }
      },
      {
        name: `default, persona at the ${where} of the default author's note`,
        presets: ["default"],
        persona: { position, depth: 2, role: 0, sent: true }
      },
      {
        name: `full, persona at the ${where} of the author's note, after main as user`,
        presets: ["full"],
        authorNote: authorNote(0, 4, 1),
        persona: { position, depth: 2, role: 0, sent: true }
      },
      {
        name: `default, persona at the ${where} of the author's note, before main as assistant`,
        presets: ["default"],
        authorNote: authorNote(2, 4, 2),
        persona: { position, depth: 2, role: 0, sent: true }
      },
      {
        name: `default, persona at the ${where} of an author's note that is switched off`,
        presets: ["default"],
        authorNote: authorNote(1, 1, 1, 0),
        persona: { position, depth: 2, role: 0, sent: false }
      },
      ...[false, true].flatMap((defaultAuthorNote) =>
        [
          authorNote(1, 0, 1),
          authorNote(0, 4, 1),
          authorNote(2, 4, 2),
          authorNote(1, 0, 0, 0),
          authorNote(1, 0, 0, 99)
        ].map((note) => ({
          name: `default, persona at the ${where} of an empty imported ${defaultAuthorNote ? "default" : "chat"} author's note, position ${note.position}, interval ${note.interval}`,
          presets: ["default"],
          lorebook: true,
          defaultAuthorNote,
          authorNote: { ...note, text: "" },
          persona: { position, depth: 2, role: 0, sent: note.interval === 1 }
        }))
      ),
      {
        name: `default, persona at the ${where} of an active author's note edited to interval zero`,
        presets: ["default"],
        lorebook: true,
        activeAuthorNote: true,
        authorNote: authorNote(1, 0, 0, 0),
        persona: { position, depth: 2, role: 0, sent: false }
      },
      {
        name: `default, persona at the ${where} of an author's note that is not due`,
        presets: ["default"],
        authorNote: authorNote(1, 1, 1, 99),
        persona: { position, depth: 2, role: 0, sent: false }
      },
      {
        name: `default, persona at the ${where} of the author's note, with lore there`,
        presets: ["default"],
        lorebook: true,
        authorNote: authorNote(1, 1, 1),
        persona: { position, depth: 2, role: 0, sent: true }
      },
      {
        name: `default, persona at the ${where} of the default author's note, with lore there`,
        presets: ["default"],
        lorebook: true,
        persona: { position, depth: 2, role: 0, sent: true }
      }
    ]),
    {
      name: "default, persona at depth",
      presets: ["default"],
      persona: { position: 4, depth: 2, role: 1, sent: true }
    },
    {
      name: "default, persona not sent",
      presets: ["default"],
      persona: { position: 9, depth: 2, role: 0, sent: false }
    },
    ...["default", "full"].flatMap((preset) =>
      (["impersonate", "swipe"] as const).map((generate) => ({
        name: `${preset}, ${generate}`,
        presets: [preset],
        generate
      }))
    )
  ]
  const differences: Array<string> = []
  const documented: Array<string> = []
  const notes: Array<string> = []
  // Whether ST sent each note with an interval: both should happen, or the case shows nothing.
  const everyOther: Array<boolean> = []
  let compared = 0
  let equal = 0
  for (const character of fixtures.gateCards) {
    for (const config of configs) {
      const { body, settings } = await captureWithSettings(
        browser,
        url,
        mock,
        {
          overMaximum: config.overMaximum ?? false,
          presets: config.presets,
          character,
          message: config.empty ? "" : MESSAGE,
          ...(config.generate ? { generate: config.generate } : {})
        },
        config.postProcessing,
        config.summary,
        config.authorNote,
        config.lorebook ? gateLore.id : undefined,
        config.persona
      )
      if (config.lorebook && !JSON.stringify(body).includes("A copper bell marks the crossing."))
        differences.push(`${character}, ${config.name}: ST sent no keyword lore`)
      if (config.authorNote?.scan && !JSON.stringify(body).includes("Wet boots squeak"))
        differences.push(
          `${character}, ${config.name}: ST didn't trigger lore on the author's note, so this compares nothing`
        )
      const ours = await ourRequest(fixtures, character, config, settings)
      const label = `${character}, ${config.name}`
      // Both sides leaving it out would compare equal: ST must have sent it.
      if (config.summary && !JSON.stringify(body).includes(config.summary.text)) {
        differences.push(`${label}: ST didn't send the summary, so this compares nothing`)
      }
      // Both sides leaving the persona out would compare equal: ST must send it where this case says.
      if (config.persona && JSON.stringify(body).includes(PERSONA_TEXT) !== config.persona.sent) {
        differences.push(
          `${label}: ST ${config.persona.sent ? "didn't send" : "sent"} the persona's description, so this compares nothing`
        )
      }
      if (config.authorNote) {
        const sent = JSON.stringify(body).includes("pretends not to notice")
        if (config.authorNote.interval !== 1) everyOther.push(sent)
        if (config.authorNote.text !== "" && config.authorNote.interval === 1 && !sent) {
          differences.push(`${label}: ST didn't send the author's note, so this compares nothing`)
        }
        notes.push(`${label}: ST ${sent ? "sent" : "didn't send"} the author's note`)
      }
      compared++
      if (ours.problem) {
        differences.push(`${label}: ${ours.problem}`)
        continue
      }
      if (config.overMaximum) {
        type Messages = { messages: ReadonlyArray<{ role: string; content: string; name?: string }> }
        const stMessages = (body as Messages).messages
        const ourMessages = (ours.body as Messages).messages
        const fixed = (messages: Messages["messages"]) => {
          const at = messages.findIndex(
            (m) =>
              m.content.includes("Older turn") ||
              m.name?.startsWith("example_") ||
              m.content === settings.new_chat_prompt ||
              m.content === settings.new_example_chat_prompt
          )
          return messages.slice(0, at)
        }
        for (const difference of diffJson(fixed(stMessages), fixed(ourMessages)))
          differences.push(`${label}: fixed prefix ${difference}`)
        const stCount = stMessages.filter((m) => m.content.includes("Older turn")).length
        const ourCount = ourMessages.filter((m) => m.content.includes("Older turn")).length
        if (stCount === 0 || stCount >= 40 || ourCount >= stCount)
          differences.push(
            `${label}: the overflow case did not show a stepped cut beyond ST's maximum cut (${ourCount} vs ${stCount})`
          )
      }
      let unexpected = 0
      for (const line of diffJson(body, ours.body)) {
        const known = DOCUMENTED.find((difference) => difference.matches(line, config, settings))
        if (known) documented.push(`${label}: ${line} [${known.why}]`)
        else differences.push(`${label}: ${line}`)
        if (!known) unexpected++
      }
      if (unexpected === 0) equal++
      notes.push(`${label}: ${(body as { messages?: ReadonlyArray<unknown> }).messages?.length ?? 0} messages`)
    }
  }
  if (!everyOther.includes(true) || !everyOther.includes(false)) {
    differences.push("the author's note with an interval was always or never sent, so its interval compares nothing")
  }
  return [
    {
      title: "Context assembler: ST's request ≠ ours",
      notes: [`${equal} of ${compared} requests equal, documented differences aside`, ...notes],
      differences
    },
    {
      title: "Context assembler: documented differences",
      notes: DOCUMENTED.map((difference) => difference.why),
      differences: documented,
      expected: "ARCHITECTURE §15 documents each"
    }
  ]
}

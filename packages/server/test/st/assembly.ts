// The context assembler against ST (DESIGN §1.2, ARCHITECTURE §15): for each gate card's
// chat, each preset and each generation type, the request ST sends and the one we build for
// the settings ST had in force must be equal, apart from the documented differences.
import type { Browser } from "@playwright/test"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { NoteDoc } from "@rp/shared/docs/note.ts"
import { Effect } from "effect"
import { chatCompletionsFields } from "../../src/assembler/wire.ts"
import { importCard } from "../../src/formats/cardImport.ts"
import { importStPreset } from "../../src/formats/preset.ts"
import * as Importers from "../../src/importer/importers.ts"
import { json, run } from "../formats/support.ts"
import type { NoteInput } from "../../src/assembler/types.ts"
import { assembleFixture, type FixtureMessage } from "../support/assemblySources.ts"
import type { FixtureSet } from "./fixtures.ts"
import { MOCK_MODEL, type MockEndpoint } from "./mock.ts"
import { diffJson, type Section } from "./report.ts"
import { type AuthorNote, captureWithSettings, savePoisonPreset, type Summary } from "./st.ts"

/** What the user sends in every capture that sends something. */
const MESSAGE = "Is the crossing still possible tonight?"
const POISON = "st-diff poison"

/** The differences ARCHITECTURE §15 documents, each with the lines of the diff it explains. */
const DOCUMENTED: ReadonlyArray<{
  readonly why: string
  readonly matches: (line: string, config: Config, settings: Record<string, unknown>) => boolean
}> = [
  { why: "we always stream (ST sends the preset's stream_openai)", matches: (line) => line.startsWith("stream:") },
  { why: "no multi-swipe requests (ST sends the preset's n above 1)", matches: (line) => line.startsWith("n:") },
  {
    why: "the preset's send_if_empty is expanded when it fills the user's turn (ST sends it as written before an impersonation)",
    matches: (line, config, settings) =>
      config.generate === "impersonate" &&
      /^messages\[\d+\]\.content: /.test(line) &&
      line.includes(`: ${JSON.stringify(settings.send_if_empty)} ≠ `)
  }
]

interface Config {
  readonly name: string
  readonly presets: ReadonlyArray<string>
  readonly generate?: "impersonate" | "swipe"
  readonly empty?: boolean
  readonly postProcessing?: string
  readonly summary?: Summary
  readonly authorNote?: AuthorNote
}

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
  first: false,
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
const authorNoteInput = (note: AuthorNote): NoteInput => ({
  entity: "author-note",
  revision: "author-note-rev",
  first: false,
  doc: {
    schema_version: 1,
    title: "Author's Note",
    content: note.text,
    placement:
      note.position === 0
        ? {
            mode: "section",
            section: "after_main_prompt",
            role: (["system", "user", "assistant"] as const)[note.role]!
          }
        : note.position === 2
          ? {
              mode: "section",
              section: "before_main_prompt",
              role: (["system", "user", "assistant"] as const)[note.role]!
            }
          : { mode: "depth", depth: note.depth, role: (["system", "user", "assistant"] as const)[note.role]! },
    owner: { chat: "chat-1" as never },
    exportable: true,
    kind: "author_note",
    interval: note.interval
  }
})

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
  const document = { ...parsed, regex_approved: true }
  const card = await imported(fixtures.cards.find((c) => c.name === character)!.png, character)
  const persona = run(importCard(json({ name: fixtures.persona.name, description: fixtures.persona.description }))).card
  const lines: Array<FixtureMessage> = fixtures.chats
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
        { entity: "persona", doc: persona }
      ],
      participants: ["character"],
      persona: "persona",
      notes: [
        ...(card.note
          ? [
              {
                entity: "note",
                revision: "note-rev",
                first: true,
                doc: { ...card.note, owner: { card: "character" as never } }
              }
            ]
          : []),
        ...(config.summary ? [summaryNote(config.summary)] : []),
        ...(config.authorNote ? [authorNoteInput(config.authorNote)] : [])
      ],
      events: [
        ...(config.summary ? [activate("summary")] : []),
        ...(config.authorNote && config.authorNote.interval > 0 ? [activate("author-note")] : [])
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
          presets: config.presets,
          character,
          message: config.empty ? "" : MESSAGE,
          ...(config.generate ? { generate: config.generate } : {})
        },
        config.postProcessing,
        config.summary,
        config.authorNote
      )
      const ours = await ourRequest(fixtures, character, config, settings)
      const label = `${character}, ${config.name}`
      // Both sides leaving it out would compare equal: ST must have sent it.
      if (config.summary && !JSON.stringify(body).includes(config.summary.text)) {
        differences.push(`${label}: ST didn't send the summary, so this compares nothing`)
      }
      if (config.authorNote) {
        const sent = JSON.stringify(body).includes("pretends not to notice")
        if (config.authorNote.interval !== 1) everyOther.push(sent)
        if (config.authorNote.interval === 1 && !sent) {
          differences.push(`${label}: ST didn't send the author's note, so this compares nothing`)
        }
        notes.push(`${label}: ST ${sent ? "sent" : "didn't send"} the author's note`)
      }
      compared++
      if (ours.problem) {
        differences.push(`${label}: ${ours.problem}`)
        continue
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

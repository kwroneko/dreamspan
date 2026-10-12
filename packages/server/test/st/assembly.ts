// The context assembler against ST (DESIGN §1.2, ARCHITECTURE §13): for each gate card's
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
import { assembleFixture, type FixtureMessage } from "../support/assemblySources.ts"
import type { FixtureSet } from "./fixtures.ts"
import { MOCK_MODEL, type MockEndpoint } from "./mock.ts"
import { diffJson, type Section } from "./report.ts"
import { captureWithSettings, savePoisonPreset } from "./st.ts"

/** What the user sends in every capture that sends something. */
const MESSAGE = "Is the crossing still possible tonight?"
const POISON = "st-diff poison"

/** The differences ARCHITECTURE §13 documents, each with the lines of the diff it explains. */
const DOCUMENTED: ReadonlyArray<{ readonly why: string; readonly matches: (line: string, config: Config) => boolean }> =
  [
    { why: "we always stream (ST sends the preset's stream_openai)", matches: (line) => line.startsWith("stream:") },
    { why: "no multi-swipe requests (ST sends the preset's n above 1)", matches: (line) => line.startsWith("n:") },
    {
      why: "the preset's send_if_empty is expanded when it fills the user's turn (ST sends it as written before an impersonation)",
      matches: (line, config) => config.generate === "impersonate" && /^messages\[\d+\]\.content: .*\{\{/.test(line)
    }
  ]

interface Config {
  readonly name: string
  readonly presets: ReadonlyArray<string>
  readonly generate?: "impersonate" | "swipe"
  readonly postProcessing?: string
}

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
  const { document } = importStPreset(JSON.stringify(settings))
  if (document === null) return { body: null, problem: "our importer didn't take the settings ST had in force" }
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
      notes: card.note
        ? [
            {
              entity: "note",
              revision: "note-rev",
              first: true,
              doc: { ...card.note, owner: { card: "character" as never } }
            }
          ]
        : [],
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
          message: MESSAGE,
          ...(config.generate ? { generate: config.generate } : {})
        },
        config.postProcessing
      )
      const ours = await ourRequest(fixtures, character, config, settings)
      const label = `${character}, ${config.name}`
      compared++
      if (ours.problem) {
        differences.push(`${label}: ${ours.problem}`)
        continue
      }
      let unexpected = 0
      for (const line of diffJson(body, ours.body)) {
        const known = DOCUMENTED.find((difference) => difference.matches(line, config))
        if (known) documented.push(`${label}: ${line} [${known.why}]`)
        else differences.push(`${label}: ${line}`)
        if (!known) unexpected++
      }
      if (unexpected === 0) equal++
      notes.push(`${label}: ${(body as { messages?: ReadonlyArray<unknown> }).messages?.length ?? 0} messages`)
    }
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
      expected: "ARCHITECTURE §13 documents each"
    }
  ]
}

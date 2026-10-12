// The comparisons the harness runs against ST, each producing report sections.
import type { Browser } from "@playwright/test"
import { CHAT_SENT_AT, type FixtureSet, MACRO_CARD } from "./fixtures.ts"
import {
  DEFAULT_MACRO_CONTEXT,
  MACRO_NOW,
  MACRO_SEED,
  MACRO_TIME_ZONE,
  MACRO_VECTORS,
  seededRandom
} from "./macroVectors.ts"
import type { MockEndpoint } from "./mock.ts"
import { expandWithOurs, OUR_ENGINE, OUR_ENGINE_IS_STUB } from "./ourMacros.ts"
import { diffJson, type Section } from "./report.ts"
import { captureRequest, evaluateMacros, savePoisonPreset } from "./st.ts"

/** What the user sends in every capture: it mentions the lantern, a lorebook keyword. */
const MESSAGE = "Where does the lantern lead?"

/**
 * ST reads what we exported: with the baseline settings, the request carries the card's
 * fields, the persona, the lorebook entries the chat triggers, and the chat itself.
 */
export const checkFixtures = async (
  browser: Browser,
  url: string,
  mock: MockEndpoint,
  fixtures: FixtureSet
): Promise<Section> => {
  const chat = fixtures.chats[0]!
  const body = await captureRequest(browser, url, mock, { presets: [], character: chat.card, message: MESSAGE })
  const sent = JSON.stringify(body)
  const expected = [...fixtures.expectedInPrompt, ...chat.lines.map((line) => line.mes), MESSAGE]
  return {
    title: "Our exported card, lorebook and chat in ST's request",
    notes: [`${expected.length} texts expected, baseline settings`],
    differences: expected
      .filter((text) => !sent.includes(JSON.stringify(text).slice(1, -1)))
      .map((text) => `missing: ${JSON.stringify(text)}`)
  }
}

/**
 * Each macro vector through ST's engine and ours: the output and the variables after it.
 * Differences on vectors marked as documented deviations are listed apart and expected.
 */
export const compareMacros = async (
  browser: Browser,
  url: string,
  fixtures: FixtureSet
): Promise<ReadonlyArray<Section>> => {
  const vectors = MACRO_VECTORS.map((vector) => ({
    ...vector,
    context: { ...DEFAULT_MACRO_CONTEXT, ...vector.context }
  }))
  const chat = fixtures.chats[0]!
  const st = await evaluateMacros(browser, url, {
    character: chat.card,
    now: MACRO_NOW,
    seed: MACRO_SEED,
    vectors: vectors.map(({ text, context }) => ({ text, context }))
  })
  const environment = {
    ...st.settings,
    card: MACRO_CARD,
    messages: chat.lines.map((line) => ({ text: line.mes, fromUser: line.is_user, sentAt: CHAT_SENT_AT }))
  }
  const differences: Array<string> = []
  const deviations: Array<string> = []
  const unobserved: Array<string> = []
  vectors.forEach((vector, i) => {
    const ours = expandWithOurs({
      text: vector.text,
      context: vector.context,
      environment,
      now: MACRO_NOW,
      timeZone: MACRO_TIME_ZONE,
      random: seededRandom(MACRO_SEED)
    })
    const lines = diffJson(st.outcomes[i], ours).map((line) => `${JSON.stringify(vector.text)} ${line}`)
    if (vector.deviation === undefined) differences.push(...lines)
    else if (lines.length > 0) deviations.push(...lines.map((line) => `${line} [${vector.deviation}]`))
    else unobserved.push(`${JSON.stringify(vector.text)}: no difference [${vector.deviation}]`)
  })
  const deviating = vectors.filter((vector) => vector.deviation !== undefined).length
  return [
    {
      title: "Macros: ST ≠ ours",
      notes: [
        `${vectors.length - deviating} vectors; ST's new engine on: ${st.newEngine}`,
        `ours: ${OUR_ENGINE}`,
        "each line: the vector, then the JSON path, ST's value ≠ ours"
      ],
      differences,
      ...(OUR_ENGINE_IS_STUB ? { expected: "our engine is a stub" } : {})
    },
    {
      title: "Macros: documented deviations",
      notes: [`${deviating} vectors`, ...unobserved],
      differences: deviations,
      expected: "ARCHITECTURE documents each"
    }
  ]
}

/**
 * Each preset file against its round trip through our importer and exporter: ST must send
 * the same request for both. The file is loaded over the baseline settings, a fresh
 * install's; the round trip over a poison preset (`savePoisonPreset`). Our importer gives
 * a field the file lacks ST's default, as a fresh ST does, so the two only match if the
 * round trip carries every setting ST applies: one it drops keeps its poisoned value.
 * The file is captured twice, so an unstable capture isn't taken for a lossy round trip.
 */
export const comparePresetRoundTrips = async (
  browser: Browser,
  url: string,
  mock: MockEndpoint,
  fixtures: FixtureSet
): Promise<Section> => {
  const character = fixtures.chats[0]!.card
  const capture = (...presets: ReadonlyArray<string>) =>
    captureRequest(browser, url, mock, { presets, character, message: MESSAGE })
  const poison = "st-diff poison"
  const settings = await savePoisonPreset(browser, url, poison)
  const baseline = await capture()
  const poisoned = diffJson(baseline, await capture(poison)).length
  const notes = [`the poison preset has ${settings} settings and changes ${poisoned} values of the baseline request`]
  const differences = poisoned === 0 ? ["the poison preset changed nothing; was it applied?"] : []
  for (const preset of fixtures.presetRoundTrips) {
    const original = await capture(preset.name)
    const again = await capture(preset.name)
    const roundTrip = await capture(poison, preset.roundTripName)
    const changed = diffJson(baseline, original).length
    const messages = (original as { messages?: ReadonlyArray<unknown> }).messages?.length ?? 0
    notes.push(
      `${preset.name}: ${messages} messages sent, ${changed} differences from the baseline, ${preset.issues} import issues`
    )
    // A preset that didn't change the request was probably never applied.
    if (changed === 0) differences.push(`${preset.name}: the request is the baseline's; was the preset applied?`)
    differences.push(
      ...diffJson(original, again).map((line) => `${preset.name}, captured twice: ${line}`),
      ...diffJson(original, roundTrip).map((line) => `${preset.name}, file ≠ round trip: ${line}`)
    )
  }
  return { title: "Preset round trips: the request ST sends", notes, differences }
}

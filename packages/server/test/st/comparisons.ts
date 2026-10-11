// The comparisons the harness runs against ST, each producing one report section.
import type { Browser } from "@playwright/test"
import { CARD_TEXT, type FixtureSet } from "./fixtures.ts"
import {
  DEFAULT_MACRO_CONTEXT,
  MACRO_NOW,
  MACRO_SEED,
  MACRO_TIME_ZONE,
  MACRO_VECTORS,
  seededRandom
} from "./macroVectors.ts"
import type { MockEndpoint } from "./mock.ts"
import { expandWithOurs, OUR_ENGINE } from "./ourMacros.ts"
import { diffJson, type Section } from "./report.ts"
import { captureRequest, evaluateMacros } from "./st.ts"

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
  const body = await captureRequest(browser, url, mock, { preset: null, character: chat.card, message: MESSAGE })
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

/** Each macro vector through ST's engine and ours: the output and the variables after it. */
export const compareMacros = async (browser: Browser, url: string, fixtures: FixtureSet): Promise<Section> => {
  const vectors = MACRO_VECTORS.map((vector) => ({
    text: vector.text,
    context: { ...DEFAULT_MACRO_CONTEXT, ...vector.context }
  }))
  const st = await evaluateMacros(browser, url, {
    character: fixtures.chats[0]!.card,
    now: MACRO_NOW,
    engine: "experimental",
    seed: MACRO_SEED,
    vectors
  })
  const differences = vectors.flatMap((vector, i) => {
    const ours = expandWithOurs({
      ...vector,
      card: CARD_TEXT,
      now: MACRO_NOW,
      timeZone: MACRO_TIME_ZONE,
      random: seededRandom(MACRO_SEED)
    })
    return diffJson(st.outcomes[i], ours).map((line) => `${JSON.stringify(vector.text)} ${line}`)
  })
  return {
    title: "Macros: ST ≠ ours",
    notes: [
      `${vectors.length} vectors; ST's new engine (on by default in a fresh install: ${st.engineOnByDefault})`,
      `ours: ${OUR_ENGINE}`
    ],
    differences
  }
}

/**
 * Each preset file against its round trip through our importer and exporter: ST must send
 * the same request for both. Every capture starts a fresh page from the baseline settings.
 * The file is captured twice, so a difference between those two marks the capture itself
 * as unstable rather than the round trip as lossy.
 */
export const comparePresetRoundTrips = async (
  browser: Browser,
  url: string,
  mock: MockEndpoint,
  fixtures: FixtureSet
): Promise<Section> => {
  const character = fixtures.chats[0]!.card
  const capture = (preset: string) => captureRequest(browser, url, mock, { preset, character, message: MESSAGE })
  const notes: Array<string> = []
  const differences: Array<string> = []
  const baseline = await captureRequest(browser, url, mock, { preset: null, character, message: MESSAGE })
  for (const preset of fixtures.presetRoundTrips) {
    const original = await capture(preset.name)
    const again = await capture(preset.name)
    const roundTrip = await capture(preset.roundTripName)
    const changed = diffJson(baseline, original).length
    const unstable = diffJson(original, again)
    const lost = diffJson(original, roundTrip)
    const messages = (original as { messages?: ReadonlyArray<unknown> }).messages?.length ?? 0
    notes.push(
      `${preset.name}: ${messages} messages sent, ${changed} differences from the baseline, ${preset.issues} import issues`
    )
    // A preset that didn't change the request was probably never applied, and would
    // compare equal to anything.
    if (changed === 0) differences.push(`${preset.name}: the request is the baseline's; was the preset applied?`)
    differences.push(
      ...unstable.map((line) => `${preset.name}, captured twice: ${line}`),
      ...lost.map((line) => `${preset.name}, file ≠ round trip: ${line}`)
    )
  }
  return { title: "Preset round trips: the request ST sends", notes, differences }
}

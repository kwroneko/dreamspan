// The ST differential harness (DESIGN §1.2): `npm run test:st`. Opt-in, outside
// `npm run check` and CI, since it needs Docker and takes minutes.
//
// It starts a stock SillyTavern in a throwaway container and a mock endpoint, runs the
// comparisons, and prints every difference. Everything it creates (the container, its
// directories) is removed when it exits, however it exits; a container left by a run that
// was killed outright is removed by the next run.
//
// Environment:
// - `ST_DIFF_TMPDIR`: where the run's directory goes (default: the OS temp directory).
// - `ST_DIFF_KEEP=1`: keep that directory, for debugging.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, chromium } from "@playwright/test"
import { removeOrphans, ST_IMAGE, ST_VERSION, startSt } from "./container.ts"
import { type FixtureSet, fixtureSet } from "./fixtures.ts"
import { type MockEndpoint, startMock } from "./mock.ts"
import { printReport, type Section } from "./report.ts"
import { captureRequest, loadFixtures, writeBaselineSettings } from "./st.ts"

const cleanups: Array<() => void> = []
const cleanUp = () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup()
    } catch (error) {
      console.error("cleanup failed:", error)
    }
  }
}
process.on("exit", cleanUp)
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    console.error(`\n${signal}: cleaning up`)
    process.exit(130)
  })
}

const main = async () => {
  removeOrphans()
  const root = mkdtempSync(join(process.env.ST_DIFF_TMPDIR ?? tmpdir(), "rp-st-diff-"))
  if (process.env.ST_DIFF_KEEP === "1") console.log(`keeping ${root}`)
  else cleanups.push(() => rmSync(root, { recursive: true, force: true }))

  const mock = await startMock()
  cleanups.push(() => void mock.stop())
  console.log(`SillyTavern ${ST_VERSION} (${ST_IMAGE})`)
  const st = await startSt(join(root, "st"), (stop) => cleanups.push(stop))
  console.log(`started ${st.name} at ${st.url}, mock at ${mock.url}`)

  const fixtures = fixtureSet()
  writeBaselineSettings(st.userDir, mock.url, fixtures)
  const browser = await chromium.launch()
  cleanups.push(() => void browser.close())
  await loadFixtures(browser, st.url, fixtures)
  console.log("fixtures loaded")

  const sections: Array<Section> = [await checkFixtures(browser, st.url, mock, fixtures)]
  return printReport(sections) === 0 ? 0 : 1
}

/**
 * ST reads what we exported: with the baseline settings, the request carries the card's
 * fields, the persona, the lorebook entries the chat triggers, and the chat itself.
 */
const checkFixtures = async (browser: Browser, url: string, mock: MockEndpoint, fixtures: FixtureSet) => {
  const message = "Where does the lantern lead?"
  const body = await captureRequest(browser, url, mock, { preset: null, character: fixtures.chats[0]!.card, message })
  const sent = JSON.stringify(body)
  const expected = [...fixtures.expectedInPrompt, ...fixtures.chats[0]!.lines.map((line) => line.mes), message]
  return {
    title: "Fixtures in ST's request (baseline settings)",
    notes: [`${expected.length} texts expected`],
    differences: expected
      .filter((text) => !sent.includes(JSON.stringify(text).slice(1, -1)))
      .map((text) => `missing: ${text}`)
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  }
)

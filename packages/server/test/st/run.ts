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
// - `ST_DIFF_ONLY=assembly,macros`: run only these comparisons (fixtures, macros, presets, assembly).
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "@playwright/test"
import { compareAssembly } from "./assembly.ts"
import { checkFixtures, compareMacros, comparePresetRoundTrips } from "./comparisons.ts"
import { removeOrphans, ST_IMAGE, ST_VERSION, startSt } from "./container.ts"
import { fixtureSet } from "./fixtures.ts"
import { startMock } from "./mock.ts"
import { printReport, type Section } from "./report.ts"
import { loadFixtures, writeBaselineSettings } from "./st.ts"

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

  const comparisons: ReadonlyArray<readonly [string, () => Promise<ReadonlyArray<Section>>]> = [
    ["fixtures", async () => [await checkFixtures(browser, st.url, mock, fixtures)]],
    ["macros", () => compareMacros(browser, st.url, fixtures)],
    ["presets", async () => [await comparePresetRoundTrips(browser, st.url, mock, fixtures)]],
    ["assembly", () => compareAssembly(browser, st.url, mock, fixtures)]
  ]
  const only = process.env.ST_DIFF_ONLY?.split(",")
  const sections: Array<Section> = []
  for (const [name, compare] of comparisons) if (!only || only.includes(name)) sections.push(...(await compare()))
  return printReport(sections) === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  }
)

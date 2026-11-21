// Typed text is never lost (ARCHITECTURE §3.10 invariant 1; owner rule): every place where
// the user types free text, typed into and reloaded (support/durability.ts says how). A place
// with a known gap is test.fail() with the gap named, so the suite is green today and a fix
// flips its test; then drop the mark. A new editor gets a Place here, and a line in the
// static list (test/textDurability.test.ts).
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { Effect } from "effect"
import type { Place, PlaceContext } from "./support/durability.ts"
import { chatPlaces } from "./support/durabilityPlaces/chat.ts"
import { libraryPlaces } from "./support/durabilityPlaces/library.ts"
import { settingsPlaces } from "./support/durabilityPlaces/settings.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, serverPerFile, withAdmin } from "./support/server.ts"

// Replies last 100 s, so a queued message stays queued; places that need a finished reply
// stop theirs (StopGeneration).
const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "40", FAKE_GENERATOR_TOKENS: "4000" })
test.describe.configure({ mode: "parallel" })

let cookie = ""
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})

const context = (): PlaceContext => ({
  server: server(),
  rpc: <A>(use: (client: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use),
  tag: Math.random().toString(36).slice(2, 8)
})

/** The file's login on this page, without spending another against the rate limit. */
const authenticate = async (page: Page) => {
  const at = cookie.indexOf("=")
  await page
    .context()
    .addCookies([
      { name: cookie.slice(0, at), value: cookie.slice(at + 1), url: server().url, httpOnly: true, sameSite: "Strict" }
    ])
  page.on("dialog", (dialog) => void dialog.accept())
}

/** A box's whole text (CodeMirror's document too), or "" while it isn't on the page. */
const valueOf = (box: Locator) =>
  box
    .evaluate(
      (element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value
        const content = element as HTMLElement & {
          cmTile?: { root: { view: { state: { doc: { toString: () => string } } } } }
        }
        return content.cmTile?.root.view.state.doc.toString() ?? element.textContent ?? ""
      },
      undefined,
      { timeout: 1000 }
    )
    .catch(() => "")

// A box still loading its text is read-only, and a key typed into it shows nothing: as a
// user does, type once it takes typing.
const typeMarker = async (box: Locator, marker: string) => {
  await expect(box).toBeEditable()
  await box.click()
  await box.press("ControlOrMeta+End")
  await box.page().keyboard.insertText(` ${marker}`)
}

/** This browser's copies of `marker` not yet acknowledged: IndexedDB's and the pending-start localStorage ones. */
const unsent = (page: Page, marker: string) =>
  page.evaluate(
    (marker) =>
      new Promise<number>((resolve) => {
        let local = 0
        for (let i = 0; i < localStorage.length; i++)
          if ((localStorage.getItem(localStorage.key(i)!) ?? "").includes(marker)) local++
        const request = indexedDB.open("dreamspan-editor-copies", 1)
        request.onerror = () => resolve(local)
        request.onsuccess = () => {
          const db = request.result
          if (!db.objectStoreNames.contains("copies")) return resolve(local)
          const all = db.transaction("copies").objectStore("copies").getAll()
          all.onsuccess = () => {
            db.close()
            resolve(local + (all.result as Array<{ content: string }>).filter((c) => c.content.includes(marker)).length)
          }
        }
      }),
    marker
  )

/** Waits out the save: at least 2 s, then until no copy holds the marker (at most 15 s more; a stuck copy still reloads). */
const settle = async (page: Page, marker: string) => {
  await page.waitForTimeout(2000)
  await expect
    .poll(() => unsent(page, marker), { timeout: 15_000 })
    .toBe(0)
    .catch(() => undefined)
}

// DURABILITY_GAPS=show runs gap tests unmarked, to see each one fail for its named reason.
const marked = process.env.DURABILITY_GAPS !== "show"
const places: ReadonlyArray<Place> = [...chatPlaces, ...libraryPlaces, ...settingsPlaces]

for (const at of places) {
  const run = async (page: Page, when: "before save" | "after save" | "mode") => {
    test.setTimeout(120_000)
    if (at.viewport) await page.setViewportSize(at.viewport)
    const ctx = context()
    await authenticate(page)
    const state = await at.setup(ctx)
    const box = await at.open(page, state, ctx)
    const marker = `durable-${ctx.tag}-${when.replace(" ", "-")}`
    await (at.type ?? typeMarker)(box, marker)
    await expect.poll(() => valueOf(box)).toContain(marker)
    if (when === "before save") await page.waitForTimeout(150)
    else await settle(page, marker)
    await page.reload()
    if (when === "mode") {
      if (at.mode) await expect(at.mode(page, state)).toBeVisible()
      await expect.poll(() => valueOf(at.shown(page, state)), { timeout: 15_000 }).toContain(marker)
      return
    }
    let again = at.shown(page, state)
    const back = await again
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false)
    if (!back) again = await at.open(page, state, ctx)
    await expect.poll(() => valueOf(again), { timeout: 15_000 }).toContain(marker)
  }

  test.describe(at.name, () => {
    test(`${at.name}: text typed just before a reload is back`, async ({ page }) => {
      test.fail(marked && at.gaps?.text !== undefined, at.gaps?.text)
      await run(page, "before save")
    })
    test(`${at.name}: text typed and saved is back after a reload`, async ({ page }) => {
      test.fail(marked && at.gaps?.text !== undefined, at.gaps?.text)
      await run(page, "after save")
    })
    test(`${at.name}: a reload reopens it where it was, with the text`, async ({ page }) => {
      const gap = at.gaps?.text ?? at.gaps?.mode
      test.fail(marked && gap !== undefined, gap)
      await run(page, "mode")
    })
  })
}

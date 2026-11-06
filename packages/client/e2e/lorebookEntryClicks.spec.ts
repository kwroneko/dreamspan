// Entry controls own their clicks, and each editor keeps its own expansion and focus.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { RefId } from "@rp/shared/library.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)

async function setup(page: Page, width = 1800, entries = 1) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const response = await page.request.post(`${server().url}/library/import?name=Entry-clicks.json`, {
    headers: { "content-type": "application/octet-stream", origin: server().url },
    data: Buffer.from(
      JSON.stringify({
        name: "Entry clicks",
        entries: Object.fromEntries(
          Array.from({ length: entries }, (_, uid) => [
            uid,
            {
              uid,
              key: uid === 0 ? ["harbour", "quay"] : [`harbour${uid}`, `quay${uid}`],
              comment: uid === 0 ? "Harbour" : `Entry ${uid}`,
              content: "Boats at the quay.",
              order: entries - uid
            }
          ])
        )
      })
    )
  })
  expect(response.status()).toBe(200)
  const ref = ((await response.json()) as { library: { ref: { id: RefId } } }).library.ref
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const made = yield* api.CreateChat({ title: "Entry clicks" })
      yield* api.ChangeCast({ chatId: made.id, slotId: null, change: { _tag: "Lorebook", ref: ref.id, active: true } })
      return made
    })
  )
  await page.goto(`${server().url}/chats/${chat.id}`)
  const tab = await openPanel(page, "Lorebooks")
  await tab
    .getByRole("list", { name: "Lorebooks in this chat" })
    .getByRole("button", { name: /^Entry clicks/ })
    .click()
  return tab.getByRole("region", { name: "Lorebook Entry clicks", exact: true })
}

const toggle = (scope: Locator, open: boolean) =>
  scope.getByRole("button", { name: `${open ? "Close" : "Open"} Harbour`, exact: true })
const keys = (scope: Locator) => scope.getByRole("textbox", { name: "Primary keys", exact: true })

for (const width of [1800, 390])
  for (const view of ["side panel", "large editor"]) {
    test(`keys line captures its click in the ${view} at ${width}`, async ({ page }) => {
      const panel = await setup(page, width)
      let scope = panel
      if (view === "large editor") {
        await panel.getByRole("link", { name: "Large editor", exact: true }).click()
        scope = page.getByRole("region", { name: "Lorebook editor", exact: true })
      }
      await scope.getByRole("button", { name: /^Keys of Harbour:/ }).click()
      await expect(keys(scope)).toBeFocused()
      await keys(scope).press("Control+End")
      await keys(scope).pressSequentially("side")
      await expect(keys(scope)).toHaveValue("harbour\nquayside")
      await keys(scope).press("Escape")
      await scope.getByText("harbour, quayside", { exact: true }).click()
      await expect(keys(scope)).toBeFocused()
      await keys(scope).press("Escape")
      await toggle(scope, true).click()
      const title = scope.getByRole("textbox", { name: "Title of Harbour", exact: true })
      await title.click()
      await expect(title).toBeFocused()
      await expect(toggle(scope, false)).toBeVisible()
      const enabled = scope.getByRole("switch", { name: "Harbour enabled" })
      await enabled.click()
      await expect(enabled).not.toBeChecked()
      await expect(toggle(scope, false)).toBeVisible()
      await scope.getByRole("button", { name: "More for Harbour", exact: true }).click()
      await expect(page.getByRole("menuitem", { name: "Duplicate", exact: true })).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(toggle(scope, false)).toBeVisible()
      const select = scope.getByRole("checkbox", { name: "Select Harbour", exact: true })
      await select.click()
      await expect(select).toBeChecked()
      await expect(toggle(scope, false)).toBeVisible()
    })
  }

test("entry expansion is independent in the side panel and large editor and survives reload", async ({ page }) => {
  let panel = await setup(page)
  await panel.getByRole("link", { name: "Large editor", exact: true }).click()
  const editor = page.getByRole("region", { name: "Lorebook editor", exact: true })
  await toggle(editor, false).click()
  await expect(toggle(editor, true)).toBeVisible()
  await expect(toggle(panel, false)).toBeVisible()
  await page.reload()
  panel = page.getByRole("region", { name: "Lorebook Entry clicks", exact: true })
  await expect(toggle(editor, true)).toBeVisible()
  await expect(toggle(panel, false)).toBeVisible()
  await toggle(panel, false).click()
  await expect(toggle(panel, true)).toBeVisible()
  await toggle(editor, true).click()
  await expect(toggle(panel, true)).toBeVisible()
  await expect(toggle(editor, false)).toBeVisible()
  // Both copies are mounted: focusing the large editor's keys must stay there.
  await editor.getByRole("button", { name: /^Keys of Harbour:/ }).click()
  await expect(keys(editor)).toBeFocused()
  await expect(keys(panel)).not.toBeFocused()
  await toggle(panel, true).click()
  await expect(toggle(editor, true)).toBeVisible()
  await expect(toggle(panel, false)).toBeVisible()
  await page.reload()
  await expect(toggle(editor, true)).toBeVisible()
  await expect(toggle(panel, false)).toBeVisible()
  await editor.getByRole("button", { name: "Collapse all", exact: true }).click()
  await page.reload()
  await expect(toggle(editor, false)).toBeVisible()
  await expect(toggle(panel, false)).toBeVisible()
  await panel.getByRole("button", { name: "Expand all", exact: true }).click()
  await page.reload()
  await expect(toggle(editor, false)).toBeVisible()
  await expect(toggle(panel, true)).toBeVisible()
  await panel.getByRole("button", { name: "Collapse all", exact: true }).click()
  await page.reload()
  await expect(toggle(editor, false)).toBeVisible()
  await expect(toggle(panel, false)).toBeVisible()
})

// A real mouse press leaves time for blur and the virtualizer's measurement before release.
// Folding the earlier keys box at pointerdown used to move the clicked row out from under it.
for (const view of ["side panel", "large editor"])
  for (const rate of [1, 6]) {
    test(`keys keep their click after another keys box blurs in the ${view}, CPU ${rate}x`, async ({
      page,
      context
    }) => {
      // Forty held presses plus tracing take longer under 6× CPU throttling. Bound each
      // action separately so a lost target still fails promptly within the larger loop budget.
      test.setTimeout(rate === 1 ? 300_000 : 600_000)
      page.setDefaultTimeout(15_000)
      const panel = await setup(page, 1800, 174)
      let scope = panel
      if (view === "large editor") {
        await panel.getByRole("link", { name: "Large editor", exact: true }).click()
        scope = page.getByRole("region", { name: "Lorebook editor", exact: true })
      }
      const cdp = await context.newCDPSession(page)
      await cdp.send("Emulation.setCPUThrottlingRate", { rate })
      // Resolve each view's unique title ID once. Repeating broad role queries for every
      // candidate row can exhaust the throttled test's budget before its clicks finish.
      const rowFor = async (title: string) => {
        const id = await scope.getByRole("textbox", { name: `Title of ${title}`, exact: true }).getAttribute("id")
        expect(id).toBeTruthy()
        return page.locator(`[id=${JSON.stringify(id)}]`).locator("xpath=ancestor::*[@role='listitem'][1]")
      }
      const earlier = await rowFor("Harbour")
      const later = await rowFor("Entry 1")
      const setOpen = async (row: Locator, title: string, open: boolean) => {
        const button = row.getByRole("button", { name: new RegExp(`^(Open|Close) ${title}$`) })
        if ((await button.getAttribute("aria-expanded")) !== String(open)) await button.click()
      }
      for (const expanded of [false, true])
        for (let attempt = 0; attempt < 20; attempt++) {
          await scope.getByRole("searchbox").focus()
          await setOpen(later, "Entry 1", expanded)
          await setOpen(earlier, "Harbour", true)
          await earlier.getByText("harbour, quay", { exact: true }).click()
          await expect(keys(earlier)).toBeFocused()
          const target = expanded
            ? later.getByText("harbour1, quay1", { exact: true })
            : later.getByRole("button", { name: /^Keys of Entry 1:/ })
          await target.scrollIntoViewIfNeeded()
          // Cycle through a key's text, the comma/space between keys and the line's trailing padding.
          const point = await target.evaluate((element, position) => {
            const box = element.getBoundingClientRect()
            let x = position === 2 ? box.right - 2 : box.x + 10
            if (position === 1 && element.firstChild) {
              const range = document.createRange()
              const comma = element.firstChild.textContent!.indexOf(",")
              range.setStart(element.firstChild, comma + 1)
              range.setEnd(element.firstChild, comma + 2)
              const gap = range.getBoundingClientRect()
              x = gap.x + gap.width / 2
            }
            return { x, y: box.y + box.height / 2 }
          }, attempt % 3)
          await page.mouse.move(point.x, point.y)
          await page.mouse.down()
          try {
            await page.waitForTimeout(80)
            const hit = await target.evaluate((element, position) => {
              const actual = document.elementFromPoint(position.x, position.y)
              return { owns: element.contains(actual), actual: actual?.outerHTML.slice(0, 250) }
            }, point)
            expect(hit, `attempt ${attempt}, expanded ${expanded}`).toMatchObject({ owns: true })
          } finally {
            await page.mouse.up()
          }
          await expect(keys(later)).toBeFocused()
          await keys(later).press("Escape")
        }
      await cdp.detach()
    })
  }

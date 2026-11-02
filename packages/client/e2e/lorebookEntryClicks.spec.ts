// Entry controls own their clicks, and each editor keeps its own expansion and focus.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { RefId } from "@rp/shared/library.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)

async function setup(page: Page, width = 1800) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const response = await page.request.post(`${server().url}/library/import?name=Entry-clicks.json`, {
    headers: { "content-type": "application/octet-stream", origin: server().url },
    data: Buffer.from(
      JSON.stringify({
        name: "Entry clicks",
        entries: {
          0: { uid: 0, key: ["harbour", "quay"], comment: "Harbour", content: "Boats at the quay.", order: 10 }
        }
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
        await panel.getByRole("button", { name: "Large editor", exact: true }).click()
        scope = page.getByRole("dialog", { name: "Lorebook editor", exact: true })
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
      await scope.getByRole("button", { name: "Select", exact: true }).click()
      const select = scope.getByRole("checkbox", { name: "Select Harbour", exact: true })
      await select.click()
      await expect(select).toBeChecked()
      await expect(toggle(scope, false)).toBeVisible()
    })
  }

test("entry expansion is independent in the side panel and large editor and survives reload", async ({ page }) => {
  let panel = await setup(page)
  await panel.getByRole("button", { name: "Large editor", exact: true }).click()
  const editor = page.getByRole("dialog", { name: "Lorebook editor", exact: true })
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

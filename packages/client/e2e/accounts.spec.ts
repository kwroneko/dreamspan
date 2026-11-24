import { expect, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

test.describe("with an admin password", () => {
  const server = serverPerFile(withAdmin)

  test("an admin creates, resets and disables a user, and the user changes their password", async ({
    page,
    browser
  }) => {
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/settings/users`)
    await page.getByRole("button", { name: "New user" }).click()
    let dialog = page.getByRole("dialog")
    await dialog.getByLabel("Handle", { exact: true }).fill("carol")
    await dialog.getByLabel("Display name").fill("Carol")
    await dialog.getByLabel("Password", { exact: true }).fill("short")
    await dialog.getByRole("button", { name: "Create user" }).click()
    await expect(dialog.getByRole("alert")).toContainText(/8/)
    await dialog.getByLabel("Password", { exact: true }).fill("carol-password-1")
    await dialog.getByRole("button", { name: "Create user" }).click()
    await expect(dialog).toBeHidden()
    const users = page.getByRole("list", { name: "Users" })
    await expect(users.locator("li", { hasText: "Carol" })).toBeVisible()

    // The same handle again is the server's to refuse.
    await page.getByRole("button", { name: "New user" }).click()
    dialog = page.getByRole("dialog")
    await dialog.getByLabel("Handle", { exact: true }).fill("carol")
    await dialog.getByLabel("Password", { exact: true }).fill("another-password-1")
    await dialog.getByRole("button", { name: "Create user" }).click()
    await expect(dialog.getByRole("alert")).toBeVisible()
    await dialog.getByRole("button", { name: "Cancel" }).click()

    await users.locator("li", { hasText: "Carol" }).getByRole("button", { name: "Set password" }).click()
    await page.getByRole("dialog").getByLabel("New password", { exact: true }).fill("carol-password-2")
    await page.getByRole("dialog").getByRole("button", { name: "Set password" }).click()
    await expect(page.getByRole("dialog")).toBeHidden()

    // Carol changes her own password, which ends her session.
    const carol = await browser.newPage()
    await apiLogin(carol.request, server(), "carol", "carol-password-2")
    await carol.goto(`${server().url}/settings/account`)
    await carol.getByLabel("Current password", { exact: true }).fill("wrong-password")
    await carol.getByLabel("New password", { exact: true }).fill("carol-password-3")
    await carol.getByRole("button", { name: "Change password" }).click()
    await expect(carol.getByRole("alert")).toContainText("current password doesn't match")
    await carol.getByLabel("Current password", { exact: true }).fill("carol-password-2")
    await carol.getByRole("button", { name: "Change password" }).click()
    await expect(carol.getByText("Password changed")).toBeVisible()
    await carol.getByLabel("Handle", { exact: true }).fill("carol")
    await carol.getByLabel("Password", { exact: true }).fill("carol-password-3")
    await carol.getByRole("button", { name: "Log in" }).click()
    await expect(carol.getByRole("navigation", { name: "Main", exact: true })).toBeVisible()
    await carol.close()

    await users.locator("li", { hasText: "Carol" }).getByRole("button", { name: "Disable" }).click()
    const confirmation = page.getByRole("alertdialog")
    await expect(confirmation.getByRole("button", { name: "Close", exact: true })).toHaveCount(0)
    await page.mouse.click(1, 1)
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole("button", { name: "Disable" }).click()
    await expect(users.locator("li", { hasText: "Carol" })).toContainText("disabled")
    await users.locator("li", { hasText: "Carol" }).getByRole("button", { name: "Enable" }).click()
    await expect(users.locator("li", { hasText: "Carol" })).not.toContainText("disabled")
  })

  // A form dialog's save from a tab a step behind is refused (owner, 2026-11-24): that tab shows
  // the current form and a restore action, with Cancel and Save in place.
  for (const { width, height } of [
    { width: 1920, height: 1080 },
    { width: 390, height: 900 }
  ]) {
    test(`a stale New user tab is refused and brings its own version back at ${width}px`, async ({ page }, info) => {
      const other = await page.context().newPage()
      await other.setViewportSize({ width, height })
      await other.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
      let hold = false
      const held: Array<() => void> = []
      await other.routeWebSocket(/\/rpc$/, (socket) => {
        const upstream = socket.connectToServer()
        socket.onMessage((data) => {
          const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string }) : null
          if (hold && request?.tag === "SaveUserDraft") held.push(() => upstream.send(data))
          else upstream.send(data)
        })
        upstream.onMessage((data) => {
          if (hold && typeof data === "string" && data.includes('"UserDraftChanged"')) return
          socket.send(data)
        })
      })
      const asked = new Set<string>()
      let answered = 0
      await page.routeWebSocket(/\/rpc$/, (socket) => {
        const upstream = socket.connectToServer()
        socket.onMessage((data) => {
          const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: string }) : null
          if (request?.tag === "SaveUserDraft" && request.id) asked.add(request.id)
          upstream.send(data)
        })
        upstream.onMessage((data) => {
          const reply = typeof data === "string" ? (JSON.parse(data) as { _tag?: string; requestId?: string }) : null
          if (reply?._tag === "Exit" && reply.requestId && asked.has(reply.requestId)) answered++
          socket.send(data)
        })
      })
      const dialogs = []
      for (const tab of [page, other]) {
        await apiLogin(tab.request, server(), ADMIN.handle, ADMIN.password)
        await tab.goto(`${server().url}/settings/users`)
        await tab.getByRole("button", { name: "New user" }).click()
        dialogs.push(tab.getByRole("dialog", { name: "New user" }))
      }
      const [mine, theirs] = dialogs as [ReturnType<typeof page.getByRole>, ReturnType<typeof page.getByRole>]
      const handle = (dialog: typeof mine) => dialog.getByLabel("Handle", { exact: true })
      const name = (dialog: typeof mine) => dialog.getByLabel("Display name")
      const use = theirs.getByRole("button", { name: "Use this tab's version", exact: true })
      const handleText = `dora-${width}`
      const displayName = `Dora from the other tab at ${width}px`
      await handle(mine).fill(handleText)
      await expect(handle(theirs)).toHaveValue(handleText)
      hold = true
      await name(theirs).fill(displayName)
      await expect.poll(() => held.length).toBeGreaterThan(0)
      const answeredBefore = answered
      await handle(mine).fill(`${handleText}-a`)
      await expect.poll(() => answered).toBeGreaterThan(answeredBefore)
      const cancel = theirs.getByRole("button", { name: "Cancel", exact: true })
      const create = theirs.getByRole("button", { name: "Create user", exact: true })
      await expect(use).toHaveCount(0)
      const cancelBefore = (await cancel.boundingBox())!
      const createBefore = (await create.boundingBox())!
      const handleBefore = (await handle(theirs).boundingBox())!
      hold = false
      for (const send of held.splice(0)) send()
      await expect(use).toBeVisible()
      await expect(handle(theirs)).toHaveValue(`${handleText}-a`)
      await expect(name(theirs)).not.toHaveValue(displayName)
      // Cancel and Create user stay where they were.
      expect(await cancel.boundingBox()).toEqual(cancelBefore)
      expect(await create.boundingBox()).toEqual(createBefore)
      expect(await handle(theirs).boundingBox()).toEqual(handleBefore)
      if (width === 390) {
        const restored = (await use.boundingBox())!
        expect(restored.y).toBeGreaterThan(cancelBefore.y + cancelBefore.height)
        expect(restored.y).toBeGreaterThan(createBefore.y + createBefore.height)
      }
      await use.hover()
      await expect(other.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(
        "Brings back this tab's changes"
      )
      const screenshot = `new-user-refused-${width}-dark.png`
      await other.screenshot({ path: info.outputPath(screenshot) })
      if (process.env.SCREENSHOT_DIR) await other.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${screenshot}` })
      await use.click()
      await expect(use).toHaveCount(0)
      await expect(handle(theirs)).toHaveValue(handleText)
      await expect(name(theirs)).toHaveValue(displayName)
      await expect(handle(mine)).toHaveValue(handleText)
      await expect(name(mine)).toHaveValue(displayName)
      await mine.getByRole("button", { name: "Cancel", exact: true }).click()
      await other.close()
    })
  }
})

test.describe("without passwords", () => {
  const server = serverPerFile()

  test("the passwordless admin is told to set a password first, then sets one and logs in", async ({ page }) => {
    await page.goto(`${server().url}/settings/users`)
    await page.getByRole("button", { name: "New user" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Handle", { exact: true }).fill("dave")
    await dialog.getByLabel("Password", { exact: true }).fill("dave-password-1")
    await dialog.getByRole("button", { name: "Create user" }).click()
    await expect(dialog.getByRole("alert")).toContainText("Set your own password before creating accounts")
    await dialog.getByRole("button", { name: "Cancel" }).click()

    await page.goto(`${server().url}/settings/account`)
    await expect(page.getByText("No account has a password")).toBeVisible()
    await expect(page.getByLabel("Current password", { exact: true })).toHaveCount(0)
    await page.getByLabel("New password", { exact: true }).fill("local-password-1")
    await page.getByRole("button", { name: "Set password" }).click()
    await expect(page.getByText("Password changed")).toBeVisible()
    await page.getByLabel("Handle", { exact: true }).fill("local")
    await page.getByLabel("Password", { exact: true }).fill("local-password-1")
    await page.getByRole("button", { name: "Log in" }).click()
    await expect(page.getByRole("navigation", { name: "Main", exact: true })).toBeVisible()
  })
})

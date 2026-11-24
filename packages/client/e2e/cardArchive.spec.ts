import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { seedCardArchive } from "./support/cardArchive.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, startServer, withAdmin } from "./support/server.ts"
import { showAppNavigation, hideAppNavigation } from "./support/appMenu.ts"
import { expectLayout } from "./support/layoutAudit.ts"

test.setTimeout(180_000)

test("a stale tab cannot offer Undo for another tab's archive", async ({ browser, page }) => {
  test.setTimeout(60_000)
  const server = await startServer(withAdmin)
  const stale = await browser.newPage()
  const name = "Archive race pilot"
  try {
    await asUser(server, ADMIN.handle, ADMIN.password, (api) => api.CreateCard({ label: name, name }))
    for (const tab of [page, stale]) {
      await apiLogin(tab.request, server, ADMIN.handle, ADMIN.password)
      await tab.goto(server.url)
    }
    const tile = (tab: typeof page) => tab.getByRole("main").getByRole("link", { name: `Open ${name}`, exact: true })
    const archive = (tab: typeof page) =>
      tab.getByRole("main").getByRole("button", { name: `Archive ${name}`, exact: true })
    await expect(archive(stale)).toBeVisible()
    await tile(page).hover()
    await archive(page).click({ timeout: 10_000 })
    const undo = page
      .locator("[data-toast]")
      .filter({ hasText: `${name} archived` })
      .getByRole("button", { name: "Undo", exact: true })
    await expect(undo).toBeVisible()
    await undo.focus()
    await tile(stale).hover()
    await archive(stale).click({ timeout: 10_000 })
    await expect(tile(stale)).toHaveCount(0)
    await expect(stale.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0)
    await undo.click()
    await expect(archive(page)).toBeVisible()
  } finally {
    await stale.close()
    await server.stop()
  }
})

test("archive rules can be restored while matching cards load or fail", async ({ page }) => {
  const server = await startServer(withAdmin)
  const other = await page.context().newPage()
  let holdSave = false
  let holdRead = false
  const saves: Array<() => void> = []
  const reads: Array<() => void> = []
  try {
    await seedCardArchive(server)
    await other.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        const request =
          typeof data === "string"
            ? (JSON.parse(data) as { tag?: string; id?: string; payload?: { criteria?: { never?: number } } })
            : null
        if (holdSave && request?.tag === "SaveUserDraft") saves.push(() => upstream.send(data))
        else if (holdRead && request?.tag === "ListArchiveCandidates" && request.payload?.criteria?.never === 72)
          reads.push(() =>
            socket.send(
              JSON.stringify({
                _tag: "Exit",
                requestId: request.id,
                exit: {
                  _tag: "Failure",
                  cause: [{ _tag: "Fail", error: { _tag: "ServerError", message: "Synthetic candidate read failure" } }]
                }
              })
            )
          )
        else upstream.send(data)
      })
      upstream.onMessage((data) => {
        if (holdSave && typeof data === "string" && data.includes('"UserDraftChanged"')) return
        socket.send(data)
      })
    })
    await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
    for (const tab of [page, other]) {
      await tab.goto(`${server.url}/?show=archived`)
      await tab.getByRole("main").getByRole("button", { name: "Archive unused cards…", exact: true }).click()
    }
    const first = page.getByRole("dialog", { name: "Archive unused cards" })
    const second = other.getByRole("dialog", { name: "Archive unused cards" })
    const days = (dialog: typeof first) => dialog.getByRole("spinbutton", { name: "Days", exact: true })
    await days(first).fill("42")
    await expect(days(second)).toHaveValue("42")
    holdSave = true
    await days(second).fill("63")
    await expect.poll(() => saves.length).toBeGreaterThan(0)
    await days(first).fill("72")
    await expect
      .poll(() =>
        asUser(server, ADMIN.handle, ADMIN.password, (api) =>
          Effect.gen(function* () {
            const ownerId = (yield* api.Whoami()).id
            const draft = yield* api.GetUserDraft({ ownerId, targetId: "archive-unused", field: "Rules" })
            return draft?.content
          })
        )
      )
      .toContain('"never":"72"')
    holdRead = true
    holdSave = false
    for (const send of saves.splice(0)) send()

    await expect(days(second)).toHaveValue("72")
    await expect.poll(() => reads.length).toBeGreaterThan(0)
    const restore = second.getByRole("button", { name: "Use this tab's version", exact: true })
    const archive = second.getByRole("button", { name: /^Archive \d+ cards$/ })
    await expect(second.getByText("Finding cards…", { exact: true })).toBeVisible()
    await expect(restore).toBeVisible()
    await expect(archive).toHaveCount(0)
    holdRead = false
    for (const fail of reads.splice(0)) fail()
    await expect(second.getByRole("button", { name: "Try again", exact: true })).toBeVisible()
    await expect(restore).toBeVisible()
    await expect(archive).toHaveCount(0)
    await restore.click()
    await expect(days(first)).toHaveValue("63")
    await expect(days(second)).toHaveValue("63")
    await expect(archive).toBeVisible()
  } finally {
    await other.close()
    await server.stop()
  }
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`${width} ${theme}: archive, search, sidebar, bulk selection and Undo`, async ({ page }, info) => {
      const server = await startServer(withAdmin)
      try {
        await seedCardArchive(server)
        await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.goto(server.url)
        const main = page.getByRole("main")
        const show = (name: string) =>
          main.getByRole("group", { name: "Show", exact: true }).getByRole("button", { name, exact: true })
        await expect(main.getByRole("link", { name: "Open Pilot 001", exact: true })).toHaveCount(0)
        await main.getByRole("searchbox", { name: "Search characters and groups" }).fill("Pilot 005")
        await main.getByRole("button", { name: "Archived (1)", exact: true }).click()
        await main.screenshot({ path: info.outputPath("archived-persona-search.png") })
        await expect(main.getByRole("link", { name: "Open Pilot 005 (persona)", exact: true })).toBeVisible()
        await expect(main.locator("[data-persona-badge]")).toHaveText("Persona")
        await main.getByRole("button", { name: "Archived (1)", exact: true }).click()
        await main.getByRole("searchbox", { name: "Search characters and groups" }).fill("Pilot 001")
        await expect(main.getByRole("button", { name: "Archived (1)", exact: true })).toHaveAttribute(
          "aria-expanded",
          "false"
        )
        await main.getByRole("button", { name: "Archived (1)", exact: true }).click()
        await expect(main.getByRole("link", { name: "Open Pilot 001", exact: true })).toBeVisible()
        await main.getByRole("searchbox", { name: "Search characters and groups" }).fill("")
        await show("Archived").click()
        await expect(main.getByRole("link", { name: "Open Pilot 001", exact: true })).toBeVisible()
        await expect(main.getByRole("link", { name: "Open Pilot 005 (persona)", exact: true })).toBeVisible()
        await expect(main.locator("[data-persona-badge]")).toHaveText("Persona")
        await expectLayout(page, info, `home-archive-${width}-${theme}`, { scope: "main" })
        await main.screenshot({ path: info.outputPath("home.png") })
        await main.getByRole("button", { name: "Unarchive Pilot 001", exact: true }).click()
        await expect(main.getByRole("link", { name: "Open Pilot 001", exact: true })).toHaveCount(0)
        await page
          .locator("[data-toast]")
          .filter({ hasText: "Pilot 001 unarchived" })
          .getByRole("button", { name: "Undo", exact: true })
          .click()
        await expect(main.getByRole("link", { name: "Open Pilot 001", exact: true })).toBeVisible()
        await main.getByRole("button", { name: "Archive unused cards…", exact: true }).click()
        const dialog = page.getByRole("dialog", { name: "Archive unused cards", exact: true })
        await expect(dialog.getByRole("checkbox", { name: "Pilot 008", exact: true })).toBeChecked()
        await expect(dialog.getByRole("checkbox", { name: "Pilot 006", exact: true })).toHaveCount(0)
        await expect(dialog.getByRole("checkbox", { name: "Pilot 007", exact: true })).toHaveCount(0)
        await dialog.getByRole("checkbox", { name: "Pilot 008", exact: true }).click()
        await expectLayout(page, info, `archive-dialog-${width}-${theme}`, { scope: '[role="dialog"]' })
        await dialog.screenshot({ path: info.outputPath("dialog.png") })
        const before = await asUser(server, ADMIN.handle, ADMIN.password, (api) =>
          api.ListArchiveCandidates({ criteria: { never: 30 } })
        )
        const n = before.length - 1
        await dialog.getByRole("button", { name: `Archive ${n} cards`, exact: true }).click()
        await expect(dialog).toHaveCount(0)
        await expect
          .poll(() =>
            asUser(server, ADMIN.handle, ADMIN.password, (api) =>
              Effect.map(api.ListLibrary({ kind: "card", archived: true }), (cards) => cards.length)
            )
          )
          .toBe(n + 5)
        await page
          .locator("[data-toast]")
          .filter({ hasText: `${n} cards archived` })
          .getByRole("button", { name: "Undo", exact: true })
          .click()
        await expect
          .poll(() =>
            asUser(server, ADMIN.handle, ADMIN.password, (api) =>
              Effect.map(api.ListLibrary({ kind: "card", archived: true }), (cards) => cards.length)
            )
          )
          .toBe(5)
        await showAppNavigation(page)
        await page
          .getByRole("group", { name: "Left panel", exact: true })
          .filter({ visible: true })
          .getByRole("button", { name: "Characters", exact: true })
          .click()
        const selector = page.getByRole("combobox", { name: "Show", exact: true }).filter({ visible: true })
        await selector.click()
        await page.getByRole("option", { name: /Archived/ }).click()
        const list = page.locator("[data-shell-list]").filter({ visible: true })
        await expect(list.getByRole("link", { name: "Open Pilot 001", exact: true })).toBeVisible()
        await expect(list.getByRole("link", { name: "Open Pilot 005 (persona)", exact: true })).toHaveCount(1)
        await expect(list.locator("[data-persona-badge]")).toHaveText("Persona")
        await expectLayout(page, info, `sidebar-archive-${width}-${theme}`, { scope: "[data-shell-list]" })
        await list.screenshot({ path: info.outputPath("sidebar.png") })
        await page.getByLabel("Find a character", { exact: true }).filter({ visible: true }).fill("No such pilot")
        await expect(list.getByText("No characters here", { exact: true })).toBeVisible()
        const archiveUnused = list.getByRole("button", { name: "Archive unused cards…", exact: true })
        await expect(archiveUnused).toBeVisible()
        await archiveUnused.click()
        await expect(dialog).toBeVisible()
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
        await hideAppNavigation(page)
      } finally {
        await server.stop()
      }
    })
  }

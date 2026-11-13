import { expect, test, type Page, type TestInfo } from "@playwright/test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import * as Database from "../../server/src/db/Database.ts"
import { saveFiles } from "../../server/src/plugins/repo.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { pluginFiles } from "./support/plugin.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile(withAdmin)
let cookie = ""
const admin = async <A>(use: Parameters<typeof withCookie<A>>[2]) =>
  withCookie(server(), cookie || (cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)), use)
const shot = async (page: Page, info: TestInfo, name: string) => {
  await expect(page.getByText("Reading plugin status…", { exact: true })).toHaveCount(0, { timeout: 60_000 })
  await expectLayout(page, info, name)
  if (process.env.SCREENSHOT_DIR) {
    await mkdir(process.env.SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({
      path: join(process.env.SCREENSHOT_DIR, `${info.title.replace(/[^a-zA-Z0-9-]/g, "-")}-${name}.png`),
      fullPage: true,
      animations: "disabled"
    })
  }
}
const plain = (id: string) => pluginFiles(id, "export const activate = () => {}", [])
const turnOn = async (page: Page) => {
  await page.getByRole("button", { name: "Turn on", exact: true }).first().click()
  await expect(page.getByRole("dialog")).toBeVisible()
}
const confirm = async (page: Page) => {
  await page.getByRole("dialog").getByRole("button", { name: "Turn on", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
}
const details = (id: string, scope = "instance") => `${server().url}/settings/plugins/${scope}~${id}?plugins=off`

test.setTimeout(240_000)
test("empty plugins at both widths and themes", async ({ page }, info) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`${server().url}/settings/plugins?plugins=off`)
      await expect(page.getByText("No plugins installed", { exact: true })).toBeVisible()
      await shot(page, info, `empty-${width}-${theme}`)
    }
})
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`consent and recovery ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const id = `settings-${width}-${theme}`
      const first = await admin((api) => api.CreatePlugin({ scope: "instance", id, files: plain(id) }))
      await page.goto(`${server().url}/settings/plugins?plugins=off`)
      await expect(page.getByRole("link", { name: id, exact: true })).toBeVisible()
      await shot(page, info, "list")
      await page.getByRole("link", { name: id, exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`instance~${id}.*plugins=off`))
      await shot(page, info, "detail-off")
      await turnOn(page)
      await expect(page.getByRole("dialog")).toContainText(
        "Runs only in your browser. It can do anything you can do in the app."
      )
      await shot(page, info, "consent-browser")
      await page.reload()
      await expect(page.getByRole("dialog")).toBeVisible()
      await confirm(page)
      await expect(page.getByText("Checks passed", { exact: true })).toBeVisible()
      await expect(page.getByText("Every account · On", { exact: true })).toBeVisible()
      await expect(page.getByText("Enabled", { exact: true })).toBeVisible()
      await shot(page, info, "detail-on")
      const updated = {
        ...plain(id),
        "server.ts": 'import { Effect } from "@rp/plugin-api/server"; export const activate = () => Effect.void'
      }
      updated["rp-plugin.json"] = JSON.stringify({
        ...JSON.parse(updated["rp-plugin.json"]),
        server: "server.ts",
        network: false
      })
      const second = await admin((api) =>
        api.CommitPlugin({ scope: "instance", id, files: updated, message: "Adds a server part" })
      )
      await page.reload()
      await page.getByRole("button", { name: "Dismiss", exact: true }).first().click()
      await turnOn(page)
      await expect(page.getByRole("dialog")).toContainText(
        "Runs on the server with full access, including stored keys and every user's chats."
      )
      await expect(page.getByRole("dialog")).toContainText("Can send data to other sites.")
      await expect(page.getByRole("dialog")).toContainText("This version can change more of the app")
      await shot(page, info, "consent-server")
      await confirm(page)
      await page.getByRole("button", { name: "Go back", exact: true }).click()
      await expect
        .poll(async () => (await admin((api) => api.GetPlugin({ scope: "instance", id }))).pin?.commit, {
          timeout: 60_000
        })
        .toBe(first)
      await expect(page.getByRole("dialog")).toHaveCount(0)
      // Wait for the detail to show the returned version before reviewing another change.
      await expect(
        page
          .locator("li")
          .filter({ hasText: first.slice(0, 8) })
          .getByText("Enabled", { exact: true })
      ).toBeVisible()
      // Returning to a previously enabled version asks again if it adds access.
      await page.getByRole("button", { name: "Go back", exact: true }).click()
      await expect(page.getByRole("dialog")).toContainText("Runs on the server with full access")
      await expect(page.getByRole("dialog")).toContainText(`Version ${second.slice(0, 8)}`)
      expect((await admin((api) => api.GetPlugin({ scope: "instance", id }))).pin?.commit).toBe(first)
      await shot(page, info, "consent-go-back")
      await page.getByRole("button", { name: "Not now", exact: true }).click()
      await page.getByRole("button", { name: "Delete its data", exact: true }).click()
      await page.goto(`${details(id)}&deleteData=1`)
      await expect(page.getByRole("alertdialog")).toContainText("The plugin stays on and may save new data.")
      await shot(page, info, "delete-data")
      await page.getByRole("button", { name: "Delete data", exact: true }).click()
      await expect(page.getByRole("alertdialog")).toHaveCount(0)
      await page.getByRole("button", { name: "Turn off", exact: true }).click()
      await expect
        .poll(async () => (await admin((api) => api.GetPlugin({ scope: "instance", id }))).pin?.suspended?.reason)
        .toBe("Plugin turned off")
      await expect(page.getByText("Turned off", { exact: true })).toBeVisible()
      await shot(page, info, "turned-off")
      // A startup suspension, replayed by the notice channel, appears once and recovers without another consent dialog.
      await admin((api) => api.PinPluginCommit({ scope: "instance", id, commit: second, consent: true }))
      await server().pause()
      await writeFile(join(server().dataDir, "plugins/instance", id, "server.ts"), "// Changed synthetic file")
      await server().restart()
      await page.goto(details(id))
      const notice = page
        .getByRole("status")
        .filter({ hasText: `${id} is off` })
        .filter({ has: page.getByRole("button", { name: "Dismiss", exact: true }) })
      await expect(notice).toHaveCount(1)
      await expect(notice).toBeVisible()
      await shot(page, info, "suspended")
      // A dirty tree refuses rollback; the check/recovery error stays visible and the pin stays suspended.
      await notice.getByRole("button", { name: "Go back", exact: true }).click()
      await expect(notice.getByRole("alert")).toBeVisible()
      await server().pause()
      await writeFile(join(server().dataDir, "plugins/instance", id, "server.ts"), updated["server.ts"])
      await server().restart()
      await page.reload()
      await expect(notice).toBeVisible()
      await notice.getByRole("button", { name: "Go back", exact: true }).click()
      await expect(notice).toHaveCount(0)
      await expect
        .poll(async () => (await admin((api) => api.GetPlugin({ scope: "instance", id }))).pin?.commit, {
          timeout: 60_000
        })
        .toBe(first)
      await shot(page, info, "recovered")
      await admin((api) => api.DisablePlugin({ scope: "instance", id }))
    })
  }

test("bad versions show their check report and stale tabs cannot apply a second action", async ({ page, context }) => {
  const id = "settings-bad"
  const commit = await admin((api) =>
    api.CreatePlugin({
      scope: "instance",
      id,
      files: pluginFiles(id, 'const n: number = "bad"; export const activate = () => {}', [])
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(details(id))
  await turnOn(page)
  await page.getByRole("dialog").getByRole("button", { name: "Turn on", exact: true }).dblclick()
  await expect(page.getByRole("dialog")).toContainText("Checks failed")
  await expect(page.getByRole("dialog")).not.toContainText(/API v1|vendored dependencies|manifest|bundle/)
  await expect(page.getByRole("dialog")).toContainText("This version's code doesn't work with this app.")
  expect((await admin((api) => api.GetPlugin({ scope: "instance", id }))).pin).toBeNull()
  await page.getByRole("button", { name: "Not now", exact: true }).click()
  const renamed = plain(id)
  renamed["rp-plugin.json"] = JSON.stringify({ ...JSON.parse(renamed["rp-plugin.json"]), name: "Updated display name" })
  const next = await admin((api) => api.CommitPlugin({ scope: "instance", id, files: renamed, message: "Fixed" }))
  await page.reload()
  await turnOn(page)
  const second = await context.newPage()
  await second.goto(details(id))
  await turnOn(second)
  await confirm(page)
  await second.getByRole("dialog").getByRole("button", { name: "Turn on", exact: true }).click()
  await expect(second.getByRole("dialog")).toContainText("Plugins changed elsewhere")
  expect((await admin((api) => api.GetPlugin({ scope: "instance", id }))).pin?.commit).toBe(next)
  expect(commit).not.toBe(next)
  await second.close()
  await page.getByRole("button", { name: "Turn on", exact: true }).nth(1).click()
  await expect(page.getByRole("dialog").getByRole("heading")).toHaveText(`Turn on ${id}?`)
  await page.getByRole("button", { name: "Not now", exact: true }).click()
})

test("non-admin views and own data controls at both widths and themes", async ({ page, context }, info) => {
  const serverFiles = plain("admin-server")
  serverFiles["rp-plugin.json"] = JSON.stringify({
    ...JSON.parse(serverFiles["rp-plugin.json"]),
    server: "client.tsx",
    client: null
  })
  await admin((api) => api.CreatePlugin({ scope: "instance", id: "admin-server", files: serverFiles }))
  const owner = await admin((api) => api.Whoami())
  const user = await admin((api) =>
    api.CreateUser({
      handle: "plugins-user",
      displayName: "Plugins user",
      role: "user",
      password: "plugins-user-password"
    })
  )
  const id = "own-client"
  const commit = await saveFiles(server().dataDir, user.id, id, plain(id), true, "Synthetic own plugin")
  await server().pause()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* Database.Writer
        yield* writer.SetPluginPins({
          userId: owner.id,
          owner: user.id,
          revision: 0,
          value: { [id]: { commit, enabledAt: 1, enabledBy: owner.id } }
        })
        yield* writer.SetPluginData({
          userId: user.id,
          owner: user.id,
          pluginId: id,
          key: "preferences",
          value: "synthetic",
          revision: 0
        })
      }).pipe(
        Effect.provide(
          Database.layer({ dataDir: server().dataDir, readers: 1, allowNetworkFs: false, workers: "bundle" })
        )
      )
    )
  )
  await server().restart()
  await apiLogin(page.request, server(), "plugins-user", "plugins-user-password")
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(details("admin-server"))
      for (const name of ["Turn on", "Turn off", "Go back", "Delete its data"])
        await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0)
      await shot(page, info, `non-admin-server-${width}-${theme}`)
      await page.goto(details(id, "user"))
      await expect(page.getByRole("button", { name: "Turn off", exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: "Delete its data", exact: true })).toBeVisible()
      await expect(page.getByText("preferences · 11 B", { exact: true })).toBeVisible()
      await shot(page, info, `non-admin-own-${width}-${theme}`)
    }
  const other = await context.newPage()
  await other.goto(details(id, "user"))
  await expect(other.getByText("preferences · 11 B", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Delete its data", exact: true }).click()
  await page.getByRole("button", { name: "Delete data", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  await expect(other.getByText("0 saved entries · 0 B", { exact: true })).toBeVisible()
  await other.close()
  await page.getByRole("button", { name: "Turn off", exact: true }).click()
  await expect(page.getByText("Your account · Off", { exact: true })).toBeVisible()
})

test("fifty plugins and long names and descriptions fit without clipping", async ({ page }, info) => {
  for (let index = 0; index < 50; index++) {
    const id = `layout-${index}`,
      files = plain(id)
    files["rp-plugin.json"] = JSON.stringify({
      ...JSON.parse(files["rp-plugin.json"]),
      name: "LongSyntheticName".repeat(7)
    })
    await admin((api) => api.CreatePlugin({ scope: "instance", id, files }))
  }
  await admin((api) =>
    api.CommitPlugin({
      scope: "instance",
      id: "layout-0",
      files: {},
      message: "VeryLongVersionDescriptionWithoutSpaces".repeat(24)
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`${server().url}/settings/plugins?plugins=off`)
      await expect(page.getByRole("link", { name: "LongSyntheticName".repeat(7), exact: true })).toHaveCount(50, {
        timeout: 60_000
      })
      await shot(page, info, `long-list-${width}-${theme}`)
      await page.goto(details("layout-0"))
      await shot(page, info, `long-detail-${width}-${theme}`)
      await turnOn(page)
      await shot(page, info, `long-consent-${width}-${theme}`)
      await page.getByRole("button", { name: "Not now", exact: true }).click()
      await page.getByRole("button", { name: "Delete its data", exact: true }).click()
      await expect(page.getByRole("alertdialog")).toBeVisible()
      await shot(page, info, `long-delete-${width}-${theme}`)
      await page.getByRole("button", { name: "Cancel", exact: true }).click()
    }
})

test("local enable syncs routes, explains reload and retains the composer draft", async ({ page }) => {
  const id = "settings-live"
  const files = pluginFiles(
    id,
    `import { type Activate } from "@rp/plugin-api/client"; export const activate: Activate = host => { host.registries.routes!.register({ id: "settings-live.page", path: "/extensions/settings-live", component: () => <p>Synthetic extension page</p> }); };`,
    ["routes"]
  )
  await admin((api) => api.CreatePlugin({ scope: "instance", id, files }))
  const chat = await admin((api) => api.CreateChat({ title: "Synthetic draft recovery" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  await page.getByLabel("Message", { exact: true }).fill("Keep this composer draft")
  await page.getByRole("link", { name: "Settings", exact: true }).first().click()
  await page.goto(`${server().url}/settings/plugins/instance~${id}`)
  await turnOn(page)
  await expect(page.getByRole("dialog")).toContainText("Reload to use changed pages.")
  await confirm(page)
  await expect(page.getByRole("status", { name: "Plugins", exact: true })).toContainText(
    "Plugins changed. Reload to apply."
  )
  await page.getByRole("button", { name: "Delete its data", exact: true }).click()
  await page.getByRole("button", { name: "Delete data", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  await expect(page.getByRole("status", { name: "Plugins", exact: true })).toContainText(
    "Plugins changed. Reload to apply."
  )
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await page.goto(`${server().url}/chats/${chat.id}`)
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep this composer draft")
})

test("detail URLs reject extra separators and encoded invalid ids", async ({ page }) => {
  const id = "url-fixture"
  await admin((api) => api.CreatePlugin({ scope: "instance", id, files: plain(id) }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const suffix of ["~other", "%7Eother", "%2Fother", ".other", "%25", "%20", "%C3%A9"]) {
    const response = await page.goto(`${server().url}/settings/plugins/instance~${id}${suffix}?plugins=off`)
    if (response?.status() !== 404)
      await expect(page.getByText("This plugin doesn't exist", { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Turn on", exact: true })).toHaveCount(0)
  }
  await page.goto(details(id))
  await turnOn(page)
  const consentUrl = page.url()
  await page.goBack()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.goForward()
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(page).toHaveURL(consentUrl)
  await page.reload()
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(page).toHaveURL(consentUrl)
  const unusual = `a${"9-".repeat(31)}9`
  for (const scope of ["instance", "user"] as const) {
    await admin((api) => api.CreatePlugin({ scope, id: unusual, files: plain(unusual) }))
    await page.goto(details(unusual, scope))
    await expect(
      page.getByText(`${scope === "instance" ? "Every" : "Your"} account · Off`, { exact: true })
    ).toBeVisible()
    await page.reload()
    await expect(page.getByRole("button", { name: "Turn on", exact: true })).toBeVisible()
  }
})

test("a changed working version after opening consent is refused", async ({ page }) => {
  const id = "consent-disk-race",
    files = plain(id)
  const commit = await admin((api) => api.CreatePlugin({ scope: "instance", id, files }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(details(id))
  await turnOn(page)
  await expect(page.getByRole("dialog")).toContainText(`Version ${commit.slice(0, 8)}`)
  await writeFile(
    join(server().dataDir, "plugins/instance", id, "rp-plugin.json"),
    JSON.stringify({
      ...JSON.parse(files["rp-plugin.json"]),
      server: "server.ts",
      network: true
    })
  )
  await page.getByRole("dialog").getByRole("button", { name: "Turn on", exact: true }).click()
  await expect(page.getByRole("dialog")).toContainText("Plugin files are unavailable or invalid")
  expect((await admin((api) => api.GetPlugin({ scope: "instance", id }))).pin).toBeNull()
})

test("deletion hover explains the permanent loss", async ({ page }) => {
  const id = "delete-hint"
  await admin((api) => api.CreatePlugin({ scope: "instance", id, files: plain(id) }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${details(id)}&deleteData=1`)
  await expect(page.getByRole("alertdialog")).toBeVisible()
  const button = page.getByRole("button", { name: "Delete data", exact: true })
  const hint = "Permanently deletes this plugin's private saved entries."
  await expect(button).toHaveAccessibleDescription(hint)
  await button.hover()
  await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(hint)
})

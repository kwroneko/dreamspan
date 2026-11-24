import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { asPage } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, MCP_LOCAL_PROGRAMS: "on" })

async function openTabs(page: Page, path: string) {
  const other = await page.context().newPage()
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
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const tab of [page, other]) await tab.goto(new URL(path, server().url).href)
  return {
    other,
    restore: other.getByRole("button", { name: "Use this tab's version", exact: true }),
    pause: () => {
      hold = true
    },
    whenHeld: () => expect.poll(() => held.length).toBeGreaterThan(0),
    release: () => {
      hold = false
      for (const send of held.splice(0)) send()
    }
  }
}

const draftContent = (page: Page, targetId: string) =>
  asPage(page, server(), (api) =>
    Effect.gen(function* () {
      const ownerId = (yield* api.Whoami()).id
      const draft = yield* api.GetUserDraft({ ownerId, targetId, field: "Settings" })
      return draft?.content ?? ""
    })
  )

test("restoring a Network draft preserves the unsaved proxy URL in this tab", async ({ page }) => {
  const conflict = await openTabs(page, "/settings/network")
  const { other, restore } = conflict
  const bypass = (tab: Page) => tab.getByLabel("Bypass list", { exact: true })
  const setProxy = (tab: Page) => tab.getByRole("radio", { name: "Set a proxy" }).click()
  await bypass(page).fill("initial")
  await expect(bypass(other)).toHaveValue("initial")
  conflict.pause()
  await bypass(other).fill("local")
  await conflict.whenHeld()
  await setProxy(page)
  await expect.poll(() => draftContent(page, "network")).toContain('"proxy":"replace"')
  conflict.release()

  await expect(restore).toBeVisible()
  const proxy = other.getByLabel("Proxy URL", { exact: true })
  const url = new URL(server().url)
  url.username = "synthetic"
  url.password = "proxy-test-secret"
  await proxy.fill(url.href)
  await restore.click()
  await expect(bypass(other)).toHaveValue("local")
  await expect(proxy).toHaveCount(0)
  expect(await bypass(other).evaluate((input) => new FormData(input.closest("form")!).has("proxyUrl"))).toBe(false)
  await setProxy(other)
  await expect(proxy).toHaveValue(url.href)
  expect(await proxy.getAttribute("value")).toBeNull()
  await expect.poll(() => draftContent(other, "network")).toContain('"proxy":"replace"')
  expect(await draftContent(other, "network")).not.toContain(url.password)

  await other.reload()
  await expect(proxy).toHaveValue("")
  await other.close()
})

test("restoring a local MCP draft preserves the bearer token only for its address", async ({ page }) => {
  const conflict = await openTabs(page, "/settings/mcp/new")
  const { other, restore } = conflict
  const choose = async (tab: Page, label: RegExp) => {
    await tab.getByLabel("Transport", { exact: true }).click()
    await tab.getByRole("option", { name: label }).click()
  }
  await choose(page, /Local program/)
  const command = other.getByLabel("Program", { exact: true })
  await expect(command).toBeVisible()
  conflict.pause()
  await command.fill("synthetic-command")
  await conflict.whenHeld()
  await choose(page, /Streamable HTTP/)
  const endpoint = new URL("/mcp", server().url).href
  await page.getByLabel("Address", { exact: true }).fill(endpoint)
  await expect.poll(() => draftContent(page, "mcp:new")).toContain(endpoint)
  conflict.release()

  await expect(restore).toBeVisible()
  const token = other.getByLabel("Bearer token", { exact: true })
  const secret = "bearer-test-secret"
  await token.fill(secret)
  await restore.click()
  await expect(command).toHaveValue("synthetic-command")
  await expect(token).toHaveCount(0)
  expect(await command.evaluate((input) => new FormData(input.closest("form")!).has("apiKey"))).toBe(false)
  await choose(other, /Streamable HTTP/)
  const address = other.getByLabel("Address", { exact: true })
  await address.fill(endpoint)
  await expect(token).toHaveValue(secret)
  expect(await token.getAttribute("value")).toBeNull()
  await address.fill(new URL("/other", server().url).href)
  await expect(token).toHaveValue("")
  await address.fill(endpoint)
  await expect(token).toHaveValue(secret)
  await expect.poll(() => draftContent(other, "mcp:new")).toContain(endpoint)
  expect(await draftContent(other, "mcp:new")).not.toContain(secret)

  await other.reload()
  await expect(address).toHaveValue(endpoint)
  await expect(token).toHaveValue("")
  await other.close()
})

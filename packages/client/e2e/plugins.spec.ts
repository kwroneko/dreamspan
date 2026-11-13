import { expect, test, type Page } from "@playwright/test"
import { writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { ADMIN, apiLogin, serverPerFile, startServer, withAdmin } from "./support/server.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { pluginFiles } from "./support/plugin.ts"
import { openPanel, closePanel } from "./support/panel.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "20", FAKE_GENERATOR_TOKENS: "400" })
let adminCookie: Promise<string> | undefined
const admin = async <A>(use: Parameters<typeof withCookie<A>>[2]) =>
  withCookie(server(), await (adminCookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)), use)
let chat = ""
let commit = ""
const id = "dice-fixture"
test.setTimeout(180_000)
test.beforeAll(async () => {
  chat = (await admin((api) => api.CreateChat({ title: "Synthetic plugin chat" }))).id
  await admin((api) =>
    api.SendMessage({
      chatId: chat as import("@rp/shared/chat.ts").ChatId,
      parentSlotId: null,
      branch: false,
      content: "Synthetic root"
    })
  )
  commit = await admin((api) => api.CreatePlugin({ scope: "instance", id, files: pluginFiles(id) }))
  expect(await admin((api) => api.EnablePlugin({ scope: "instance", id, commit, consent: true }))).toMatchObject({
    ok: true
  })
})
const open = async (page: Page, search = "") => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat}${search}`)
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible()
}
const sync = (page: Page) =>
  page.evaluate(async () => {
    const url = "/plugin-host.mjs"
    const host = (await import(/* @vite-ignore */ url)) as { syncClientPlugins: () => Promise<void> }
    await host.syncClientPlugins()
  })
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`composer and panel under CSP: ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      const violations: string[] = []
      await page.exposeFunction("pluginCsp", (s: string) => violations.push(s))
      await page.addInitScript(() =>
        document.addEventListener("securitypolicyviolation", (e) =>
          (window as unknown as { pluginCsp: (s: string) => void }).pluginCsp(e.violatedDirective)
        )
      )
      test.setTimeout(60000)
      await open(page)
      expect(
        await page.evaluate(async () => {
          const url = "/plugin-host.mjs"
          const host = await import(/* @vite-ignore */ url)
          return ["jsx", "ui", "rpc", "useState", "syncClientPlugins"].every((key) => key in host)
        })
      ).toBe(true)
      await page.getByLabel("Message", { exact: true }).fill("Kept draft ")
      await page.getByRole("button", { name: `Roll ${id}` }).click()
      await expect(page.getByRole("button", { name: `Roll ${id}` })).toHaveAttribute(
        "data-plugin-context",
        "busy,compact,draft,ready"
      )
      await expect(page.getByRole("button", { name: `Roll ${id}` })).toHaveAttribute("data-plugin-draft", "append")
      await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Kept draft 🎲 20")
      await expectLayout(page, info, "plugin composer")
      await openPanel(page, id)
      await expect(page.getByText(`Plugin panel for ${chat}`)).toBeVisible()
      await expect(page.getByText(`Plugin panel for ${chat}`)).toHaveAttribute(
        "data-plugin-panel-context",
        "active,chatId,forkId"
      )
      await expectLayout(page, info, "plugin panel")
      await page.reload()
      await expect(page.getByText(`Plugin panel for ${chat}`)).toBeVisible()
      expect(violations).toEqual([])
    })
  }
test("safe-start URL survives deep links, panel choices and navigation", async ({ page }) => {
  const loads: string[] = []
  page.on("request", (r) => {
    if (/\/plugins\/.*\/client.mjs/.test(r.url())) loads.push(r.url())
  })
  await open(page, "?plugins=off&panel=model")
  await expect(page.getByRole("button", { name: `Roll ${id}` })).toHaveCount(0)
  await openPanel(page, "This chat")
  await expect(page).toHaveURL(/plugins=off/)
  await page.reload()
  await expect(page).toHaveURL(/plugins=off/)
  if (await page.getByRole("dialog").isVisible()) await closePanel(page)
  await page.getByRole("link", { name: "Library", exact: true }).first().click()
  await expect(page).toHaveURL(/plugins=off/)
  expect(loads).toEqual([])
  for (const path of [
    "/login",
    "/settings/account",
    "/extensions/unknown",
    `/chats/${chat}?panel=${encodeURIComponent(`/plugins/instance/${id}/${commit}/client.mjs`)}`
  ]) {
    await page.goto(`${server().url}${path}${path.includes("?") ? "&" : "?"}plugins=off`)
    await expect(page.getByRole("main").first()).toBeVisible()
    await expect(page.getByRole("button", { name: `Roll ${id}` })).toHaveCount(0)
    expect(loads).toEqual([])
  }
})
test("other tabs offer reload; live disable removes an open panel and focused control without losing drafts", async ({
  page,
  context
}) => {
  await open(page)
  const other = await context.newPage()
  await open(other)
  await page.getByLabel("Message", { exact: true }).fill("Keep me")
  await openPanel(page, id)
  await admin((api) => api.DisablePlugin({ scope: "instance", id }))
  await expect(other.getByRole("status", { name: "Plugins" })).toContainText("Plugins changed")
  await sync(page)
  await expect(page.getByText(`Plugin panel for ${chat}`)).toHaveCount(0)
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep me")
  expect(await admin((api) => api.EnablePlugin({ scope: "instance", id, commit, consent: true }))).toMatchObject({
    ok: true
  })
  await sync(page)
  await page.getByRole("button", { name: `Roll ${id}` }).focus()
  await admin((api) => api.DisablePlugin({ scope: "instance", id }))
  await sync(page)
  await expect(page.getByRole("button", { name: `Roll ${id}` })).toHaveCount(0)
  await expect(page.getByLabel("Message", { exact: true })).toBeFocused()
  await admin((api) => api.EnablePlugin({ scope: "instance", id, commit, consent: true }))
  await other.close()
})
test("content containing module URLs, import maps, scripts and links never imports a plugin", async ({ page }) => {
  await open(page, "?plugins=off")
  const loads: string[] = []
  page.on("request", (r) => {
    if (r.url().includes("/plugins/")) loads.push(r.url())
  })
  const url = `/plugins/instance/${id}/${commit}/client.mjs`
  const content = `${url}\n<script type="importmap">{"imports":{"x":"${url}"}}</script>\n<script type="module" src="${url}"></script>\n[module](${url})`
  await page.getByLabel("Message", { exact: true }).fill(content)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("article", { name: "Your message" }).last()).toContainText(url)
  expect(loads).toEqual([])
  const card = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: { name: "Synthetic module text", description: content, first_mes: content }
  }
  const imported = await page.request.post(`${server().url}/library/import?name=synthetic-module.json`, {
    data: Buffer.from(JSON.stringify(card)),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(imported.status()).toBe(200)
  const result = (await imported.json()) as { library: { ref: { id: string } } }
  await page.goto(`${server().url}/library/${result.library.ref.id}?plugins=off`)
  await expect(page.getByRole("main")).toBeVisible()
  expect(loads).toEqual([])
})
test("assets require authentication, ownership, enabled pin and checked exact path; changed trees and stale caches fail", async ({
  page,
  playwright
}) => {
  await open(page)
  const path = `/plugins/instance/${id}/${commit}/client.mjs`
  const response = await page.request.get(server().url + path)
  expect(response.status()).toBe(200)
  expect(response.headers()["cache-control"]).toBe("no-store, private")
  expect(response.headers()["content-type"]).toContain("text/javascript")
  expect(response.headers()["x-content-type-options"]).toBe("nosniff")
  expect(response.headers()["cross-origin-resource-policy"]).toBe("same-origin")
  expect((await page.request.get(server().url + path, { headers: { "service-worker": "script" } })).status()).toBe(404)
  const head = await page.request.head(server().url + path)
  expect(head.status()).toBe(200)
  expect((await head.body()).length).toBe(0)
  expect(head.headers()["cache-control"]).toBe("no-store, private")
  const ranged = await page.request.get(server().url + path, { headers: { range: "bytes=0-1" } })
  expect(ranged.status()).toBe(200)
  expect(await ranged.body()).toEqual(await response.body())
  for (const suffix of ["/", "/check.json", "/client.mjs.map", "/font.woff2", "/image.png", "/theme.css"])
    expect((await page.request.get(server().url + path.replace("/client.mjs", suffix))).status()).toBe(404)
  const anonymous = await playwright.request.newContext()
  expect((await anonymous.get(server().url + path)).status()).toBe(401)
  await anonymous.dispose()
  for (const bad of [
    path.replace("client.mjs", "client.tsx"),
    path.replace("client.mjs", "%63lient.mjs"),
    path.replace("client.mjs", "other.mjs"),
    path.replace(commit, "a".repeat(40)),
    path.replace("client.mjs", "%2e%2e%2fcheck.json")
  ])
    expect((await page.request.get(server().url + bad)).status()).toBe(404)
  await admin((api) => api.DisablePlugin({ scope: "instance", id }))
  const disabled = await page.request.get(server().url + path, {
    headers: { "if-none-match": '"synthetic"', "if-modified-since": new Date().toUTCString() }
  })
  expect(disabled.status()).toBe(404)
  expect(disabled.headers()["cache-control"]).toBe("no-store, private")
  expect((await page.request.head(server().url + path)).status()).toBe(404)
  await admin((api) => api.EnablePlugin({ scope: "instance", id, commit, consent: true }))
  await writeFile(
    join(server().dataDir, "plugins/instance", id, "client.tsx"),
    pluginFiles(id)["client.tsx"] + "\n// changed"
  )
  expect((await page.request.get(server().url + path)).status()).toBe(404)
  await writeFile(join(server().dataDir, "plugins/instance", id, "client.tsx"), pluginFiles(id)["client.tsx"])
  const output = join(server().dataDir, "plugins/.builds/instance", id, commit, "client.mjs")
  const checked = await readFile(output)
  try {
    await writeFile(output, Buffer.alloc(16 * 1024 * 1024 + 1, 32))
    expect((await page.request.get(server().url + path)).status()).toBe(404)
  } finally {
    await writeFile(output, checked)
  }
})

test("user assets stay private across accounts and rollback cannot revive a stale cached revision", async ({
  page,
  playwright
}) => {
  await open(page)
  const id = "private-fixture"
  const original = pluginFiles(id, "export const activate = () => undefined;", [])
  const first = await admin((api) => api.CreatePlugin({ scope: "user", id, files: original }))
  expect(await admin((api) => api.EnablePlugin({ scope: "user", id, commit: first, consent: true }))).toMatchObject({
    ok: true
  })
  const path = (commit: string) => `${server().url}/plugins/user/${id}/${commit}/client.mjs`
  expect((await page.request.get(path(first))).status()).toBe(200)
  await admin((api) =>
    api.CreateUser({
      handle: "plugin-reader",
      displayName: "Reader",
      role: "user",
      password: "synthetic-reader-password"
    })
  )
  const other = await playwright.request.newContext()
  await apiLogin(other, server(), "plugin-reader", "synthetic-reader-password")
  expect((await other.get(path(first))).status()).toBe(404)
  expect(
    (await admin((api) => api.ListClientPlugins())).some((plugin) => plugin.scope === "user" && plugin.id === id)
  ).toBe(true)
  expect(
    (
      await withCookie(server(), await loginCookie(server(), "plugin-reader", "synthetic-reader-password"), (api) =>
        api.ListClientPlugins()
      )
    ).some((plugin) => plugin.scope === "user" && plugin.id === id)
  ).toBe(false)
  // Instance code is explicitly enabled for every authenticated account.
  expect((await other.get(`${server().url}/plugins/instance/dice-fixture/${commit}/client.mjs`)).status()).toBe(200)
  const second = await admin((api) =>
    api.CommitPlugin({
      scope: "user",
      id,
      files: { "client.tsx": "export const activate = () => { console.log('synthetic revision two') };" },
      message: "Synthetic update"
    })
  )
  expect((await page.request.get(path(first))).status()).toBe(404)
  await admin((api) => api.EnablePlugin({ scope: "user", id, commit: second, consent: true }))
  expect((await page.request.get(path(second))).status()).toBe(200)
  expect((await page.request.get(path(first))).status()).toBe(404)
  expect(await admin((api) => api.PinPluginCommit({ scope: "user", id, commit: first, consent: true }))).toMatchObject({
    ok: true
  })
  const rolledBack = await page.request.get(path(first))
  expect(rolledBack.status()).toBe(200)
  expect(rolledBack.headers()["cache-control"]).toBe("no-store, private")
  expect((await page.request.get(path(second))).status()).toBe(404)
  await other.dispose()
})

test("routes load before the router, live controls apply while routes request reload, and disabled routes stop rendering", async ({
  page
}, info) => {
  await open(page)
  const id = "route-fixture"
  const source =
    'import {type Activate} from "@rp/plugin-api/client"; export const activate: Activate = host => { host.registries.routes!.register({id:"route.fixture",path:"/extensions/fixture",component:()=> <p>Synthetic plugin route</p>}); host.registries.appBanners!.register({id:"route.banner",order:0,component:()=> <p>Route plugin activated</p>}) };'
  const commit = await admin((api) =>
    api.CreatePlugin({ scope: "instance", id, files: pluginFiles(id, source, ["routes", "appBanners"]) })
  )
  expect(await admin((api) => api.EnablePlugin({ scope: "instance", id, commit, consent: true }))).toMatchObject({
    ok: true
  })
  await sync(page)
  await expect(page.getByText("Route plugin activated", { exact: true })).toBeVisible()
  await expect(page.getByRole("status", { name: "Plugins" })).toContainText("Reload to apply")
  await page.goto(`${server().url}/extensions/fixture`)
  await expect(page.getByText("Synthetic plugin route", { exact: true })).toBeVisible()
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await expectLayout(page, info, `plugin route ${width} ${theme}`)
    }
  await admin((api) => api.DisablePlugin({ scope: "instance", id }))
  await sync(page)
  await expect(page.getByText("Synthetic plugin route", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("status", { name: "Plugins" })).toContainText("Reload to apply")
})

test("live changes preserve a draft and an already streaming reply", async ({ page }) => {
  const connection = await admin((api) =>
    api.CreateConnection({
      kind: "openai-chat",
      apiKey: null,
      settings: {
        name: "Synthetic plugin stream",
        baseUrl: "http://127.0.0.1:9/v1",
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      }
    })
  )
  const model = await admin((api) => api.AddUserModel({ connectionId: connection.id, key: "gpt-4o", overrides: {} }))
  await admin((api) =>
    api.SetGenerationDefaults({ defaults: { model: { connection: connection.id, model: model.id }, preset: null } })
  )
  const streamChat = await admin((api) => api.CreateChat({ title: "Synthetic plugin stream" }))
  const sent = await admin((api) =>
    api.SendMessage({
      chatId: streamChat.id,
      parentSlotId: null,
      branch: false,
      content: "Synthetic stream",
      reply: false
    })
  )
  if (sent._tag !== "Posted") throw new Error("Synthetic seed was queued")
  await admin((api) => api.Generate({ chatId: streamChat.id, parentSlotId: sent.entry.slotId, branch: false }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${streamChat.id}`)
  const stop = page.getByRole("button", { name: "Stop", exact: true }).first()
  await expect(stop).toBeVisible()
  const draft = page.getByLabel("Message", { exact: true })
  await draft.fill("Keep this during the reply")
  await page.getByRole("button", { name: `Roll ${id}` }).focus()
  await admin((api) => api.DisablePlugin({ scope: "instance", id }))
  await sync(page)
  await expect(draft).toHaveValue("Keep this during the reply")
  await expect(draft).toBeFocused()
  await expect(stop).toBeVisible()
  expect(await admin((api) => api.EnablePlugin({ scope: "instance", id, commit, consent: true }))).toMatchObject({
    ok: true
  })
  await sync(page)
  await expect(page.getByRole("button", { name: `Roll ${id}` })).toBeVisible()
  await expect(draft).toHaveValue("Keep this during the reply")
  await expect(stop).toBeVisible()
  await stop.click()
})

test("plugin assets cannot install persistent service workers", async ({ page }) => {
  const id = "worker-cache"
  const commit = await admin((api) =>
    api.CreatePlugin({ scope: "instance", id, files: pluginFiles(id, "export const activate = () => undefined;", []) })
  )
  expect(await admin((api) => api.EnablePlugin({ scope: "instance", id, commit, consent: true }))).toMatchObject({
    ok: true
  })
  await open(page)
  try {
    const result = await page.evaluate(async (url) => {
      try {
        const registration = await navigator.serviceWorker.register(url, { type: "module" })
        await registration.unregister()
        return { status: "registered", reason: "" }
      } catch (error) {
        return { status: "denied", reason: String(error) }
      }
    }, `/plugins/instance/${id}/${commit}/client.mjs`)
    console.log("SERVICE_WORKER_REGISTRATION", result)
    expect(result.status).toBe("denied")
  } finally {
    await admin((api) => api.DisablePlugin({ scope: "instance", id }))
  }
})

test("local sessions cannot install plugin service workers either", async ({ browser }) => {
  const local = await startServer()
  const context = await browser.newContext()
  const id = "local-worker-cache"
  const api = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(local, "", use)
  try {
    const commit = await api((client) =>
      client.CreatePlugin({
        scope: "instance",
        id,
        files: pluginFiles(id, "export const activate = () => undefined;", [])
      })
    )
    expect(await api((client) => client.EnablePlugin({ scope: "instance", id, commit, consent: true }))).toMatchObject({
      ok: true
    })
    const page = await context.newPage()
    await page.goto(local.url + "/settings/account")
    await expect(page.getByRole("heading", { name: "Account", level: 1, exact: true })).toBeVisible()
    const result = await page.evaluate(async (url) => {
      try {
        const registration = await navigator.serviceWorker.register(url, { type: "module" })
        await registration.unregister()
        return { status: "registered", reason: "" }
      } catch (error) {
        return { status: "denied", reason: String(error) }
      }
    }, `/plugins/instance/${id}/${commit}/client.mjs`)
    console.log("LOCAL_SERVICE_WORKER_REGISTRATION", result)
    expect(result.status).toBe("denied")
  } finally {
    await context.close()
    await local.stop()
  }
})

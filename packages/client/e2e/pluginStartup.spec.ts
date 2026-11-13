import { expect, test, type Browser, type Page } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"
import { pluginFiles } from "./support/plugin.ts"

const current = serverPerFile({
  ...withAdmin,
  ...(process.env.PLUGIN_CLIENT_DIST ? { CLIENT_DIST: process.env.PLUGIN_CLIENT_DIST } : {})
})
const baseline = process.env.PLUGIN_BASELINE_DIST
  ? serverPerFile({ ...withAdmin, CLIENT_DIST: process.env.PLUGIN_BASELINE_DIST })
  : null
const watchReady = (page: Page) =>
  page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const title = document.querySelector("h1")
      if (title?.textContent !== "Account" || title.getBoundingClientRect().width === 0) return
      ;(window as unknown as { pluginReadyMs: number }).pluginReadyMs = performance.now()
      observer.disconnect()
    })
    observer.observe(document, { childList: true, subtree: true, characterData: true })
  })
const readReady = async (page: Page) => {
  const value = await page.evaluate(() => (window as unknown as { pluginReadyMs?: number }).pluginReadyMs)
  if (value === undefined) throw new Error("Account heading readiness was not recorded")
  return value
}
const measure = async (browser: Browser, url: string) => {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await watchReady(page)
    await apiLogin(context.request, { url } as ReturnType<typeof current>, ADMIN.handle, ADMIN.password)
    await page.goto(`${url}/settings/account`)
    await page.getByRole("heading", { name: "Account", level: 1, exact: true }).waitFor()
    return {
      readyMs: await readReady(page),
      scripts: await page.evaluate(
        () => performance.getEntriesByType("resource").filter((e) => e.name.endsWith(".js")).length
      )
    }
  } finally {
    await context.close()
  }
}
test("startup with no plugins and ten checked modules", async ({ browser }, info) => {
  test.setTimeout(300_000)
  const empty: Array<{ readyMs: number; scripts: number }> = []
  const before: Array<{ readyMs: number; scripts: number }> = []
  for (let i = 0; i < 5; i++) {
    if (baseline && i % 2 === 0) before.push(await measure(browser, baseline().url))
    empty.push(await measure(browser, current().url))
    if (baseline && i % 2 !== 0) before.push(await measure(browser, baseline().url))
  }
  const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(current(), ADMIN.handle, ADMIN.password, use)
  for (let i = 0; i < 10; i++) {
    const id = `startup-${i}`
    const source = `import {type Activate} from "@rp/plugin-api/client"; export const activate: Activate = host => { host.registries.appBanners!.register({id:"${id}",order:${i},component:()=> <p>${id} loaded</p>}) };`
    const commit = await admin((api) =>
      api.CreatePlugin({ scope: "instance", id, files: pluginFiles(id, source, ["appBanners"]) })
    )
    expect(await admin((api) => api.EnablePlugin({ scope: "instance", id, commit, consent: true }))).toMatchObject({
      ok: true
    })
  }
  const context = await browser.newContext()
  let ten
  try {
    const page = await context.newPage()
    await watchReady(page)
    await apiLogin(context.request, current(), ADMIN.handle, ADMIN.password)
    await page.goto(`${current().url}/settings/account`)
    await expect(page.getByRole("heading", { name: "Account", level: 1, exact: true })).toBeVisible()
    for (let i = 0; i < 10; i++) await expect(page.getByText(`startup-${i} loaded`, { exact: true })).toBeVisible()
    ten = {
      readyMs: await readReady(page),
      modules: await page.evaluate(
        () => performance.getEntriesByType("resource").filter((e) => e.name.endsWith("/client.mjs")).length
      )
    }
    expect(ten.modules).toBe(10)
    await expect(page.getByRole("status", { name: "Plugins" })).toHaveCount(0)
  } finally {
    await context.close()
  }
  const measurements = { before, empty, ten }
  console.log(`PLUGIN_STARTUP ${JSON.stringify(measurements)}`)
  await info.attach("plugin startup", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" })
  if (baseline) {
    const median = (values: typeof empty) => [...values].sort((a, b) => a.readyMs - b.readyMs)[2]!.readyMs
    expect(median(empty)).toBeLessThan(median(before) * 1.1)
  }
})

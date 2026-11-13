import { expect, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { withCookie, loginCookie } from "./support/rpc.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { pluginFiles } from "./support/plugin.ts"

const server = serverPerFile(withAdmin)
let adminCookie: Promise<string> | undefined
const admin = async <A>(use: Parameters<typeof withCookie<A>>[2]) =>
  withCookie(server(), await (adminCookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)), use)
test.setTimeout(180_000)
const failures = [
  "import",
  "registration",
  "render",
  "event",
  "effect",
  "async-event",
  "never",
  "never-import",
  "never-render"
] as const
const component = (kind: string) =>
  kind === "never-render"
    ? "() => { use(pending); return <p>Never visible</p> }"
    : kind === "render"
      ? '() => { throw new Error("synthetic render") }'
      : kind === "effect"
        ? '() => { useEffect(() => { throw new Error("synthetic effect") }, []); return <p>Never visible</p> }'
        : kind === "event"
          ? '() => <button title="Tests a failed plugin action" onClick={() => { throw new Error("synthetic event") }}>Break event</button>'
          : kind === "async-event"
            ? '() => <ui.Button hint="Tests a failed asynchronous plugin action" onClick={async () => { throw new Error("synthetic async event") }}>Break event</ui.Button>'
            : "() => <p>Failed registration should disappear</p>"
for (const kind of failures) {
  test(`${kind} failure leaves the app usable and reports once`, async ({ page }) => {
    const id = `failure-${kind}`
    const body = `import { ui, use, useEffect, type Activate } from "@rp/plugin-api/client";
const pending = new Promise<void>(() => {});
${kind === "import" ? 'throw new Error("synthetic import")' : kind === "never-import" ? "await new Promise(() => {});" : ""}
export const activate: Activate = ${
      kind === "never"
        ? "async () => { await new Promise(() => {}) }"
        : `host => {
 host.registries.appBanners!.register({ id: "${id}.banner", order: 0, component: ${component(kind)} });
 ${kind === "registration" ? 'throw new Error("synthetic registration")' : ""}
}`
    };`
    const commit = await admin((api) =>
      api.CreatePlugin({ scope: "instance", id, files: pluginFiles(id, body, ["appBanners"]) })
    )
    const report = await admin((api) => api.EnablePlugin({ scope: "instance", id, commit, consent: true }))
    expect(report).toMatchObject({ ok: true })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/settings/account`)
    await expect(page.getByRole("heading", { name: "Account", level: 1, exact: true })).toBeVisible()
    if (kind === "event" || kind === "async-event") await page.getByRole("button", { name: "Break event" }).click()
    await expect(page.getByRole("status", { name: "Plugins" })).toContainText(id)
    const part =
      kind === "render" || kind === "effect" || kind === "async-event" || kind === "never-render"
        ? `${id}.banner`
        : kind === "event"
          ? "event"
          : "load"
    await expect(page.locator(`[data-plugin-error="${part}"]`)).toHaveCount(1)
    const message = `${id}${kind === "render" || kind === "effect" || kind === "async-event" || kind === "never-render" ? " had a problem. One part is hidden." : " failed and is off here."}`
    await expect(page.getByText(message, { exact: true })).toHaveCount(1)
    await expect(page.getByText("Failed registration should disappear")).toHaveCount(0)
    await admin((api) => api.DisablePlugin({ scope: "instance", id }))
  })
}
test("two plugins claiming the same slot name preserve the first and undo the failed plugin", async ({ page }) => {
  for (const id of ["claim-first", "claim-second"]) {
    const body = `import { type Activate } from "@rp/plugin-api/client"; export const activate: Activate = host => { host.registries.appBanners!.register({ id: "shared.banner", order: 0, component: () => <p>${id} owns this</p> }) };`
    const commit = await admin((api) =>
      api.CreatePlugin({ scope: "instance", id, files: pluginFiles(id, body, ["appBanners"]) })
    )
    expect(await admin((api) => api.EnablePlugin({ scope: "instance", id, commit, consent: true }))).toMatchObject({
      ok: true
    })
  }
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/account`)
  await expect(page.getByText(/claim-(first|second) owns this/)).toHaveCount(1)
  await expect(page.locator('[data-plugin-error="load"]')).toHaveCount(1)
  for (const id of ["claim-first", "claim-second"]) await admin((api) => api.DisablePlugin({ scope: "instance", id }))
})

test("failure and reload banners fit at 1440 and 390 in both themes", async ({ page }, info) => {
  const id = "failure-layout"
  const source = 'export const activate = () => { throw new Error("synthetic layout failure") };'
  const commit = await admin((api) => api.CreatePlugin({ scope: "instance", id, files: pluginFiles(id, source, []) }))
  expect(await admin((api) => api.EnablePlugin({ scope: "instance", id, commit, consent: true }))).toMatchObject({
    ok: true
  })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/account`)
  await expect(page.getByRole("status", { name: "Plugins" })).toContainText(id)
  await admin((api) => api.DisablePlugin({ scope: "instance", id }))
  await expect(page.getByRole("status", { name: "Plugins" })).toContainText("Plugins changed")
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await expectLayout(page, info, `plugin banners ${width} ${theme}`)
    }
})

test("a pending action rejected during disable cannot report into the next scope", async ({ page }) => {
  const id = "late-rejection"
  const source = `import {ui,type Activate} from "@rp/plugin-api/client";
let reject: (reason?: unknown) => void = () => undefined;
export const activate: Activate = host => {
  host.onDispose(() => reject(new Error("synthetic disposal")));
  host.registries.appBanners!.register({id:"late.action",order:0,component:()=> <ui.Button hint="Starts an action that waits until the plugin turns off" onClick={()=>new Promise<void>((_,no)=>{reject=no})}>Start pending</ui.Button>});
};`
  const commit = await admin((api) =>
    api.CreatePlugin({ scope: "instance", id, files: pluginFiles(id, source, ["appBanners"]) })
  )
  expect(await admin((api) => api.EnablePlugin({ scope: "instance", id, commit, consent: true }))).toMatchObject({
    ok: true
  })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/account`)
  await page.getByRole("button", { name: "Start pending" }).click()
  await admin((api) => api.DisablePlugin({ scope: "instance", id }))
  await page.evaluate(async () => {
    const url = "/plugin-host.mjs"
    const host = await import(/* @vite-ignore */ url)
    await host.syncClientPlugins()
  })
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
  )
  await expect(page.getByRole("button", { name: "Start pending" })).toHaveCount(0)
  await expect(page.locator("[data-plugin-error]")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Account", level: 1, exact: true })).toBeVisible()
})

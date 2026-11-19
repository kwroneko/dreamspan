// Adversarial display plugins (review-adapters2). Each is approved, checked source, as a
// user or the assistant could write it: the page must still contain whatever it returns and
// stay responsive whatever its worker does. Synthetic text only; the "other site" is a
// loopback recorder on another origin.
import { test, expect, type Page } from "@playwright/test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import type { SlotId } from "@dreamspan/shared/chat.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { withCookie, loginCookie } from "./support/rpc.ts"

const server = serverPerFile(withAdmin)
let cookie: Promise<string> | undefined
const admin = async <A>(use: Parameters<typeof withCookie<A>>[2]) =>
  withCookie(server(), await (cookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)), use)

let outside: { readonly url: string; readonly seen: string[]; readonly close: () => Promise<void> }
test.beforeAll(async () => {
  const seen: string[] = []
  const http = createServer((request, response) => {
    seen.push(request.url ?? "")
    response.setHeader("access-control-allow-origin", "*")
    response.setHeader("content-type", "text/javascript")
    response.end("export default 1")
  })
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done))
  outside = {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise((done) => http.close(() => done()))
  }
})
test.afterAll(async () => {
  await outside?.close()
})

const manifest = (id: string, surfaces: ReadonlyArray<string>, replaces: ReadonlyArray<string>) =>
  JSON.stringify({
    id,
    name: id,
    api: 1,
    server: null,
    worker: null,
    client: "client.tsx",
    surfaces: surfaces.map((s) => `client:${s}`),
    overrides: [],
    replaces,
    network: false,
    base: null
  })
/** Creates, checks and approves one exact version, as the consent dialog's "Turn on" does. */
const approve = async (id: string, files: Record<string, string>, commitOnly = false) => {
  const existing = await admin((api) => api.ListPlugins()).then((all) =>
    all.some((p) => p.scope === "user" && p.id === id)
  )
  const commit = await admin((api) =>
    existing
      ? api.CommitPlugin({ scope: "user", id, files, message: "Synthetic change" })
      : api.CreatePlugin({ scope: "user", id, files })
  )
  const report = await admin((api) => api.CheckPlugin({ scope: "user", id, commit }))
  expect(report.ok, JSON.stringify(report).slice(0, 2000)).toBe(true)
  if (!commitOnly)
    expect(await admin((api) => api.EnablePlugin({ scope: "user", id, commit, consent: true }))).toMatchObject({
      ok: true
    })
  return commit
}
const chatWith = async (title: string, contents: ReadonlyArray<string>) =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title })
      yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
      const slots: SlotId[] = []
      let parent = null as SlotId | null
      for (const content of contents) {
        const sent = yield* api.SendMessage({ chatId: chat.id, parentSlotId: parent, branch: false, content })
        if (sent._tag !== "Posted") throw new Error("Unexpected queue")
        slots.push(sent.entry.slotId)
        parent = sent.entry.slotId
      }
      return { chat, slots }
    })
  )
const bodyOf = (page: Page, slot: string) => page.locator(`article[data-slot="${slot}"] .markdown`).first()
const failedBanner = (page: Page) => page.getByRole("status", { name: "Plugins", exact: true })
/** Source positions differ between a stored text and a text a rule returned; nothing else may. */
const comparable = (html: string) => html.replace(/ data-source-map="[^"]*"/g, "")

test("whatever a display copy returns is sanitised exactly as stored text is, and never runs", async ({ page }) => {
  test.setTimeout(240_000)
  const payload = [
    "Shown text",
    "<script>globalThis.displayInjected=1</script>",
    '<img src="x" onerror="globalThis.displayInjected=1">',
    `<img src="${outside.url}/image.png">`,
    `![remote](${outside.url}/markdown.png)`,
    "[script link](javascript:globalThis.displayInjected=1)",
    '<a href="javascript:globalThis.displayInjected=1">raw script link</a>',
    '<a href="data:text/html,<script>parent.displayInjected=1</script>">data link</a>',
    `<style>body{background:url(${outside.url}/style.png)} input[value^="a"]{background:url(${outside.url}/a)}</style>`,
    `<div style="background:url(${outside.url}/inline.png);position:fixed;inset:0">overlay</div>`,
    `<form action="${outside.url}/form" method="post"><input name="password" type="password"><button type="submit">Sign in</button></form>`,
    `<iframe src="${outside.url}/frame"></iframe>`,
    `<iframe srcdoc="<script>parent.displayInjected=1</script>"></iframe>`,
    `<object data="${outside.url}/object"></object><embed src="${outside.url}/embed">`,
    `<link rel="stylesheet" href="${outside.url}/sheet.css"><meta http-equiv="refresh" content="0;url=${outside.url}/meta"><base href="${outside.url}/">`,
    '<svg><script>globalThis.displayInjected=1</script><a xlink:href="javascript:globalThis.displayInjected=1">svg</a></svg>',
    '<math><mtext><img src="x" onerror="globalThis.displayInjected=1"></mtext></math>',
    '<button onclick="globalThis.displayInjected=1" formaction="javascript:globalThis.displayInjected=1">press</button>'
  ].join("\n\n")
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  // The first message stores the payload: the built-in renders it. The second stores a
  // harmless word, and the copy returns the same payload for it.
  const made = await chatWith("Hostile display output", [payload, "REPLACE-ME"])
  await approve("hostile-output", {
    "dreamspan-plugin.json": manifest(
      "hostile-output",
      ["displayTransforms", "timelineTransforms"],
      ["displayTransforms:display.macros", "timelineTransforms:timeline.merges"]
    ),
    "client.tsx": `import type { Activate } from "@dreamspan/plugin-api/client"
const payload = ${JSON.stringify(payload)}
export const activate: Activate = host => {
  host.registries.displayTransforms!.register({ api: 1, id: "display.macros", order: 10,
    transform: input => ({ text: input.text === "REPLACE-ME" ? payload : input.text, issues: [] }) })
  host.registries.timelineTransforms!.register({ api: 1, id: "timeline.merges", order: 5,
    transform: input => [...input.rows, { key: "hostile-row", estimate: 44, from: Infinity, to: -1, body: { kind: "text", text: payload } }] })
}`
  })
  const requests: string[] = []
  page.on("request", (request) => {
    if (request.url().startsWith(outside.url)) requests.push(request.url())
  })
  await page.goto(`${server().url}/chats/${made.chat.id}`)
  const stored = bodyOf(page, made.slots[0]!)
  const returned = bodyOf(page, made.slots[1]!)
  await expect(returned).toContainText("Shown text")
  await expect(stored).toContainText("Shown text")
  // The timeline's literal row goes through the same renderer.
  const row = page.locator(".markdown").filter({ hasText: "Shown text" }).nth(2)
  await expect(row).toBeVisible()
  await expect.poll(async () => comparable(await returned.innerHTML())).toBe(comparable(await stored.innerHTML()))
  expect(comparable(await row.innerHTML())).toBe(comparable(await stored.innerHTML()))
  await expect(failedBanner(page)).toHaveCount(0)
  // Absolute properties of the app page, whatever the sanitiser keeps.
  const found = await page.evaluate(() => {
    const within = [...document.querySelectorAll("main *")]
    return {
      injected: (globalThis as unknown as { displayInjected?: number }).displayInjected,
      scripts: document.querySelectorAll("main script, article script").length,
      handlers: within.filter((element) => element.getAttributeNames().some((name) => /^on/i.test(name))).length,
      links: within.filter((element) =>
        ["href", "src", "action", "formaction", "xlink:href", "data"].some((name) =>
          /^\s*(javascript|data|vbscript):/i.test(element.getAttribute(name) ?? "")
        )
      ).length,
      frames: [...document.querySelectorAll("iframe")].filter(
        (frame) => !frame.hasAttribute("sandbox") || /allow-same-origin/.test(frame.getAttribute("sandbox") ?? "")
      ).length,
      embedded: document.querySelectorAll("main object, main embed, main base, main meta, main link").length,
      // A password field itself is kept, for stored text and returned text alike (the
      // comparison above); what matters is that no form can send it anywhere.
      actions: [...document.querySelectorAll("main form, main button, main input")].filter(
        (element) => element.hasAttribute("action") || element.hasAttribute("formaction")
      ).length
    }
  })
  expect(found).toEqual({
    injected: undefined,
    scripts: 0,
    handlers: 0,
    links: 0,
    frames: 0,
    embedded: 0,
    actions: 0
  })
  expect(requests).toEqual([])
  expect(outside.seen).toEqual([])
  await admin((api) => api.DisablePlugin({ scope: "user", id: "hostile-output" }))
})

test("the worker of a display copy reaches no other site, cannot evaluate text as code and has no page", async ({
  page
}) => {
  test.setTimeout(240_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const made = await chatWith("Worker reach", ["Probe here"])
  const socket = outside.url.replace("http", "ws")
  // Loading further code is refused before approval: the check rejects a dynamic import.
  const importing = await admin((api) =>
    api.CreatePlugin({
      scope: "user",
      id: "importing",
      files: {
        "dreamspan-plugin.json": manifest("importing", ["displayTransforms"], ["displayTransforms:display.macros"]),
        "client.tsx": `import type { Activate } from "@dreamspan/plugin-api/client"
export const activate: Activate = async () => { const url = "${outside.url}/module.mjs"; await import(url) }`
      }
    })
  )
  expect(await admin((api) => api.CheckPlugin({ scope: "user", id: "importing", commit: importing }))).toMatchObject({
    ok: false,
    message: expect.stringContaining("dynamic imports")
  })
  await approve("worker-reach", {
    "dreamspan-plugin.json": manifest("worker-reach", ["displayTransforms"], ["displayTransforms:display.macros"]),
    "client.tsx": `import type { Activate } from "@dreamspan/plugin-api/client"
const g = globalThis as unknown as Record<string, any>
const found: string[] = []
const attempt = async (name: string, run: () => unknown) => {
  try {
    const value = await Promise.race([run(), new Promise((_, reject) => setTimeout(() => reject(new Error("silent")), 800))])
    found.push(name + "=" + String(value))
  } catch {
    found.push(name + "=refused")
  }
}
export const activate: Activate = async host => {
  await Promise.all([
    attempt("otherSiteFetch", () => g.fetch("${outside.url}/fetch", { mode: "no-cors" }).then((r: any) => "sent" + r.type)),
    attempt("otherSiteSocket", () => new Promise((open, refuse) => { const s = new g.WebSocket("${socket}/socket"); s.onopen = () => open("open"); s.onerror = () => refuse(new Error("refused")) })),
    attempt("otherSiteEvents", () => new Promise((open, refuse) => { const s = new g.EventSource("${outside.url}/events"); s.onopen = () => open("open"); s.onerror = () => refuse(new Error("refused")) })),
    attempt("evaluate", () => (0, g.eval)("1+1")),
    attempt("makeFunction", () => new g.Function("return 2")()),
    attempt("blobWorker", () => new Promise((ran, refuse) => { const w = new g.Worker(g.URL.createObjectURL(new g.Blob(["postMessage(1)"], { type: "text/javascript" }))); w.onmessage = () => ran("ran"); w.onerror = () => refuse(new Error("refused")) })),
    attempt("page", () => typeof g.document + typeof g.window + typeof g.localStorage + typeof g.parent),
    attempt("ownAppRequest", () => g.fetch("/plugins/client.json").then((r: any) => r.status))
  ])
  host.registries.displayTransforms!.register({ api: 1, id: "display.macros", order: 10,
    transform: input => ({ text: input.text + " PROBE[" + found.sort().join(";") + "]", issues: [] }) })
}`
  })
  await page.goto(`${server().url}/chats/${made.chat.id}`)
  const body = bodyOf(page, made.slots[0]!)
  await expect(body).toContainText("PROBE[")
  const probe = /PROBE\[([^\]]*)\]/.exec((await body.textContent()) ?? "")![1]!.split(";")
  expect(probe).toEqual([
    "blobWorker=refused",
    "evaluate=refused",
    "makeFunction=refused",
    "otherSiteEvents=refused",
    "otherSiteFetch=refused",
    "otherSiteSocket=refused",
    // The limit consent states ("It can do anything you can do in the app"): the worker is
    // the app's origin with the user's session. Pinned here so a change is deliberate.
    "ownAppRequest=200",
    "page=undefinedundefinedundefinedundefined"
  ])
  expect(outside.seen).toEqual([])
  await admin((api) => api.DisablePlugin({ scope: "user", id: "worker-reach" }))
})

const misbehaviours: ReadonlyArray<readonly [string, string]> = [
  ["never answers", "transform: () => new Promise(() => {})"],
  ["loops forever", "transform: () => { for (;;) {} }"],
  ["returns the wrong type", "transform: () => ({ text: { toString: () => 'x' }, issues: 'none' }) as never"],
  ["returns more than the limit", "transform: () => ({ text: 'x'.repeat(1_000_001), issues: [] })"],
  [
    "floods the page with forged answers",
    "transform: () => { for (let i = 0; i < 20000; i++) post({ kind: 'result', seq: i, value: { text: 'forged ' + 'x'.repeat(2000), issues: [] } }); return new Promise(() => {}) }"
  ],
  [
    "keeps posting after a correct answer",
    "transform: input => { setTimeout(() => { for (let i = 0; i < 20000; i++) post({ kind: 'result', seq: i, value: { text: 'late', issues: [] } }) }, 0); return { text: input.text, issues: [] } }"
  ],
  [
    "answers with a structure that cannot be an answer",
    "transform: () => { const map = new Map([['text', 'x']]); post({ kind: 'result', seq: 2, value: map }); post([1, 2, 3]); post(null); return new Promise(() => {}) }"
  ]
]
test("a display copy that hangs, floods or forges answers is turned off and the built-in text shows", async ({
  page
}) => {
  test.setTimeout(600_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const made = await chatWith("Worker misbehaviour", ["Built-in **text**"])
  const chatUrl = `${server().url}/chats/${made.chat.id}`
  await page.goto(chatUrl)
  const body = bodyOf(page, made.slots[0]!)
  await expect(body.locator("strong")).toHaveText("text")
  const original = await body.innerHTML()
  for (const [name, rule] of misbehaviours) {
    await test.step(name, async () => {
      await approve("misbehaving", {
        "dreamspan-plugin.json": manifest("misbehaving", ["displayTransforms"], ["displayTransforms:display.macros"]),
        "client.tsx": `import type { Activate } from "@dreamspan/plugin-api/client"
const post = (message: unknown) => (globalThis as unknown as { postMessage: (message: unknown) => void }).postMessage(message)
export const activate: Activate = host => {
  host.registries.displayTransforms!.register({ api: 1, id: "display.macros", order: 10, ${rule} })
}`
      })
      await page.goto(chatUrl)
      await expect(failedBanner(page)).toContainText("failed and is off here", { timeout: 20_000 })
      await expect(body.locator("strong")).toHaveText("text")
      await expect.poll(() => body.innerHTML()).toBe(original)
      await expect(body).not.toContainText("forged")
      // The page was never blocked: typing answers at once.
      const started = Date.now()
      await page.getByRole("textbox", { name: "Message", exact: true }).fill(`Still responsive after ${name}.`)
      expect(Date.now() - started).toBeLessThan(5_000)
      await admin((api) => api.DisablePlugin({ scope: "user", id: "misbehaving" }))
    })
  }
})

test("only the approved build of a display copy runs: later edits, a tampered build and another tab", async ({
  page,
  context
}) => {
  test.setTimeout(300_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const made = await chatWith("Approved display build", ["Approved text"])
  const chatUrl = `${server().url}/chats/${made.chat.id}`
  const source = (marker: string) => ({
    "dreamspan-plugin.json": manifest("approved-display", ["displayTransforms"], ["displayTransforms:display.macros"]),
    "client.tsx": `import type { Activate } from "@dreamspan/plugin-api/client"
export const activate: Activate = host => {
  host.registries.displayTransforms!.register({ api: 1, id: "display.macros", order: 10,
    transform: input => ({ text: input.text + " ${marker}", issues: [] }) })
}`
  })
  // Another tab is open before anything is approved.
  const other = await context.newPage()
  await other.goto(chatUrl)
  const otherBody = bodyOf(other, made.slots[0]!)
  await expect(otherBody).toContainText("Approved text")

  const approved = await approve("approved-display", source("[first approved]"))
  await page.goto(chatUrl)
  const body = bodyOf(page, made.slots[0]!)
  await expect(body).toContainText("[first approved]")
  // The other tab never starts new code by itself: it offers a reload and keeps the original.
  await other.bringToFront()
  await expect(other.getByRole("status", { name: "Plugins", exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(otherBody).not.toContainText("[first approved]")
  await other.reload()
  await expect(bodyOf(other, made.slots[0]!)).toContainText("[first approved]")
  await other.close()
  await page.bringToFront()

  // A second plugin replacing the same rule is refused while the first is on.
  const rival = await admin((api) =>
    Effect.gen(function* () {
      const commit = yield* api.CreatePlugin({
        scope: "user",
        id: "rival-display",
        files: {
          "dreamspan-plugin.json": manifest(
            "rival-display",
            ["displayTransforms"],
            ["displayTransforms:display.macros"]
          ),
          "client.tsx": source("[rival]")["client.tsx"]
        }
      })
      yield* api.CheckPlugin({ scope: "user", id: "rival-display", commit })
      return yield* Effect.result(api.EnablePlugin({ scope: "user", id: "rival-display", commit, consent: true }))
    })
  )
  expect(JSON.stringify(rival)).toContain("already replaces this part")
  await page.reload()
  await expect(body).toContainText("[first approved]")
  await expect(body).not.toContainText("[rival]")

  // A newer checked commit and a dirty working file: neither was approved, neither runs.
  await approve("approved-display", source("[second unapproved]"), true)
  const user = await admin((api) => api.Whoami())
  const working = join(server().dataDir, "plugins/users", user.id, "approved-display", "client.tsx")
  await writeFile(working, (await readFile(working, "utf8")).replace("[second unapproved]", "[dirty unapproved]"))
  await page.reload()
  await expect(body).toContainText("[first approved]")
  await expect(body).not.toContainText("unapproved")

  // The approved build's bytes change on disk: the copy is suspended and the built-in returns.
  const output = join(server().dataDir, "plugins/.builds", user.id, "approved-display", approved, "client.mjs")
  const checked = await readFile(output, "utf8")
  expect(checked).toContain("[first approved]")
  await writeFile(output, checked.replace("[first approved]", "[tampered build]"))
  await page.reload()
  await expect(body).toContainText("Approved text")
  await expect(body).not.toContainText("[tampered build]")
  await expect(body).not.toContainText("[first approved]")
  expect((await admin((api) => api.GetPlugin({ scope: "user", id: "approved-display" }))).pin?.suspended).toBeDefined()
})

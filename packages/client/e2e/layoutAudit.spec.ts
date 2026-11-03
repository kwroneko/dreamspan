// Run before UI approval: LAYOUT_AUDIT=1 PLAYWRIGHT_WORKERS=1 npx playwright test -c
// packages/client/playwright.config.ts e2e/layoutAudit.spec.ts --project=chromium
// LAYOUT_AUDIT_ST_FOLDER can point to an existing SYNTHETIC fixture only.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, EntityId, VersionId } from "@rp/shared/chat.ts"
import { findStRoots } from "@rp/shared/stFolder.ts"
import type { RefId } from "@rp/shared/library.ts"
import { layoutAudit, expectLayout } from "./support/layoutAudit.ts"
import { loginCookie, withCookie, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, startServer, type TestServer, withAdmin } from "./support/server.ts"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { closePanel, openPanel, openSummarySettings } from "./support/panel.ts"
import { showAppNavigation, hideAppNavigation } from "./support/appMenu.ts"
import { level1 } from "./support/summaries.ts"
import { writeScaleFolder } from "./support/stScaleFolder.ts"
import { writeRealisticStFolder } from "../../server/test/support/stRealistic.ts"

// Opt-in: it imports a large synthetic library and still reports known findings, so the default
// browser suite (`npm run test:browser`, the release gate's `e2e/`) leaves it out.
test.skip(!process.env["LAYOUT_AUDIT"], "the layout audit runs only with LAYOUT_AUDIT=1")

test.use({
  reducedMotion: "reduce",
  // Every finding already has measured evidence and a crop. Repeated snapshots of
  // the scale library make a six-viewport trace needlessly large.
  trace: "off",
  screenshot: "only-on-failure",
  launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--disable-features=OverlayScrollbar"] }
})

// Deliberately broken fixtures prove each rule reports measured defects, and the
// exceptions don't hide defects inside an overlay. No app CSS or fixed snapshots.
test("the detector catches geometry defects and respects documented intent", async ({ page }) => {
  await page.setContent(`<style>
    body { margin: 20px; font: 14px Arial; }
    section { border: 1px solid; padding: 12px; margin-bottom: 20px; width: 300px; }
    button { width: 50px; height: 30px; padding: 8px; }
  </style>
  <section id="edge" style="padding:0"><button>Edge</button></section>
  <section><div id="text" style="width:80px;overflow:hidden;white-space:nowrap">A very long clipped sentence without an ellipsis</div></section>
  <section id="gaps" style="display:flex;gap:8px"><button>A</button><button style="margin-left:5px">B</button><button>C</button></section>
  <section id="align" style="display:flex;align-items:center;gap:8px"><button>A</button><button style="transform:translateY(4px)">B</button></section>
  <section id="overlap" style="display:flex"><button>A</button><button style="margin-left:-10px">B</button></section>
  <section id="menu-edge" style="padding:0"><div role="menuitem" tabindex="0">Menu action</div></section>`)
  const found = await layoutAudit(page)
  expect(new Set(found.map((v) => v.kind))).toEqual(new Set(["inset", "text", "gap", "alignment", "overlap"]))
  expect(found.find((v) => v.kind === "inset" && v.related === "#edge")?.measurement).toContain("left 0.00px")
  expect(found.find((v) => v.kind === "alignment")?.measurement).toContain("4.00px")
  expect(found.some((v) => v.kind === "inset" && v.related === "#menu-edge")).toBe(true)
  await page.setContent(`<style>body{margin:20px}button{padding:8px}</style>
    <div style="width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Intended ellipsis on this very long text</div>
    <div data-layout-audit-ignore="inset: joined segments share an outer border" style="border:1px solid"><button>A</button></div>
    <button style="position:absolute;top:80px;left:20px">Behind</button>
    <div data-layout-overlay="tooltip floats above the page" style="position:absolute;top:80px;left:20px"><button>Above</button></div>`)
  expect(await layoutAudit(page)).toEqual([])
  await page.locator("[data-layout-overlay]").evaluate((el) => {
    ;(el as HTMLElement).style.cssText += ";border:1px solid;padding:0"
  })
  expect((await layoutAudit(page)).some((v) => v.kind === "inset")).toBe(true)
  // Open shadow roots (the real code editor uses one) aren't invisible to the audit.
  await page.setContent('<div id="host"></div>')
  await page.locator("#host").evaluate((el) => {
    el.attachShadow({ mode: "open" }).innerHTML =
      '<div style="border:1px solid;padding:0"><button>Bad inset</button></div>'
  })
  expect((await layoutAudit(page)).some((v) => v.selector.includes(">>>"))).toBe(true)
  await page.setContent(`<style>body{margin:20px;font:16px Arial}</style>
    <div id="icon-row" style="display:flex;align-items:center;gap:8px">
      <svg width="16" height="16" style="transform:translateY(4px)"><path d="M0 0h16v16H0z" /></svg><span>Label</span>
    </div>
    <div style="position:absolute;top:100px;left:20px"><span>First text</span></div>
    <div style="position:absolute;top:100px;left:25px"><span>Second text</span></div>
    <div id="scroll" style="position:absolute;top:160px;width:180px;height:60px;overflow:auto;border:1px solid">
      <div style="height:120px;padding:12px"><button style="position:relative;left:110px;width:80px">Crosses</button></div>
    </div>`)
  const across = await layoutAudit(page)
  expect(across.some((v) => v.kind === "alignment" && v.selector === "#icon-row")).toBe(true)
  expect(across.some((v) => v.kind === "overlap" && v.measurement.startsWith("content intersection"))).toBe(true)
  expect(across.some((v) => v.kind === "inset" && v.related === "#scroll")).toBe(true)
  await page.setContent('<div data-layout-audit-ignore="inset"><button>Missing reason</button></div>')
  expect((await layoutAudit(page)).some((v) => v.kind === "exception")).toBe(true)
  await page.setContent(`<div id="vertical" style="height:8px;overflow:hidden"><span>Clipped vertically</span></div>
    <div style="display:flex;align-items:center;gap:8px;padding:12px;width:300px">
      <button>First</button><span style="flex:1"></span><button>Second</button><button>Third</button>
    </div>
    <div style="display:flex;align-items:center;gap:8px;padding:12px">
      <button>First</button><button style="opacity:0">Reserved hover action</button><button>Third</button><button>Fourth</button>
    </div>
    <div style="display:flex;align-items:center;gap:8px;padding:12px">
      <button>First</button><span style="display:contents"><button>Second</button></span><button>Third</button><button>Fourth</button>
    </div>
    <div style="display:grid;grid-template-columns:40px 200px auto;align-items:center;gap:8px;padding:12px">
      <div style="grid-row:1/span 2;height:60px">Face</div>
      <span style="grid-column:2;grid-row:1">Title</span><span style="grid-column:2;grid-row:2">Metadata</span>
      <button style="grid-column:3;grid-row:1/span 2">Action</button>
    </div>
    <p style="font:13px monospace;white-space:pre-wrap;width:85px">one two three four five six seven</p>`)
  const clipping = await layoutAudit(page)
  expect(clipping.some((v) => v.kind === "text" && v.related === "#vertical")).toBe(true)
  expect(clipping.every((v) => v.kind !== "gap")).toBe(true)
  expect(clipping.filter((v) => v.kind === "text").every((v) => v.related === "#vertical")).toBe(true)
})

const work = process.env.LAYOUT_AUDIT_WORK ?? mkdtempSync(join(tmpdir(), "rp-layout-audit-"))
const selected = new RegExp(process.env.LAYOUT_AUDIT_SURFACES ?? ".*")
// Surfaces to keep a whole-window screenshot of, for before-and-after evidence (shots/ in the work folder).
const shots = process.env.LAYOUT_AUDIT_SHOTS ? new RegExp(process.env.LAYOUT_AUDIT_SHOTS) : null

// Inspect content below the fold as well as the initial viewport. Message history
// and editable field interiors have separate tests; don't page a 188k-message timeline.
async function sampleScrollEnds(page: Page, check: (suffix: string) => Promise<void>) {
  const count = await page.evaluate(() => {
    const scrolls = [
      ...document.querySelectorAll<HTMLElement>("main, main *, aside, aside *, [role=dialog], [role=dialog] *")
    ].filter((el) => {
      const s = getComputedStyle(el),
        r = el.getBoundingClientRect()
      return (
        el.checkVisibility() &&
        r.height > 120 &&
        r.width > 80 &&
        r.top < innerHeight &&
        r.bottom > 0 &&
        /auto|scroll/.test(s.overflowY) &&
        el.scrollHeight > el.clientHeight + 1 &&
        !el.closest('[data-testid="messages"]') &&
        !el.matches("textarea, [contenteditable]")
      )
    })
    scrolls.forEach((el, i) => el.setAttribute("data-layout-audit-scroll", String(i)))
    return scrolls.length
  })
  for (let i = 0; i < count; i++) {
    const box = page.locator(`[data-layout-audit-scroll="${i}"]`)
    const original = await box.evaluate((el) => el.scrollTop)
    await box.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await check(`-scroll-${i}-end`)
    await box.evaluate((el, top) => {
      el.scrollTop = top
    }, original)
  }
  await page
    .locator("[data-layout-audit-scroll]")
    .evaluateAll((els) => els.forEach((el) => el.removeAttribute("data-layout-audit-scroll")))
}

test.describe("synthetic library and every app surface", () => {
  test.describe.configure({ mode: "default" })

  let server: TestServer
  let provider: FakeProvider
  let chatId: ChatId, cardId: EntityId, cardRef: RefId, presetRef: RefId, bookRef: RefId, replyId: VersionId
  let connectionId = "",
    cardName = "",
    cookie = ""
  const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server, cookie, use)
  test.beforeAll(async () => {
    test.setTimeout(3_600_000)
    mkdirSync(work, { recursive: true })
    server = await startServer({
      ...withAdmin,
      DATA_DIR: join(work, "data"),
      ...(process.env.LAYOUT_AUDIT_CLIENT_DIST ? { CLIENT_DIST: process.env.LAYOUT_AUDIT_CLIENT_DIST } : {})
    })
    provider = await startProvider()
    cookie = await loginCookie(server, ADMIN.handle, ADMIN.password)
    const cards = await admin((api) => api.ListLibrary({ kind: "card" }))
    if (
      (cards.length < 422 || !existsSync(join(work, "scale-import-complete"))) &&
      process.env.LAYOUT_AUDIT_SMALL !== "1"
    ) {
      // dataset.md's archived fixture may have been pruned; regenerate from the
      // checked-in synthetic generator rather than silently auditing an empty app.
      const folder = process.env.LAYOUT_AUDIT_ST_FOLDER ?? join(work, "synthetic-scale")
      if (process.env.LAYOUT_AUDIT_ST_FOLDER && !existsSync(folder))
        throw new Error(`Synthetic fixture is missing: ${folder}`)
      if (!process.env.LAYOUT_AUDIT_ST_FOLDER) {
        if (!existsSync(join(folder, "data/default-user/settings.json")))
          writeScaleFolder(folder, { cards: 422, chats: 2102, longChats: 3, groups: 20 })
        // Match dataset.md's message scale. The general generator has a heavier
        // long tail; thin only this job's freshly generated synthetic chat files.
        if (!existsSync(join(work, "scale-sized"))) {
          const user = join(folder, "data/default-user")
          const files = ["chats", "group chats"].flatMap((dir) =>
            readdirSync(join(user, dir), { recursive: true, encoding: "utf8" })
              .filter((name) => name.endsWith(".jsonl"))
              .map((name) => join(user, dir, name))
          )
          const chats = files.map((path) => ({ path, lines: readFileSync(path, "utf8").trimEnd().split("\n") }))
          const total = chats.reduce((sum, c) => sum + c.lines.length - 1, 0)
          const budget = Math.min(188000, total)
          const counts = chats.map((c) => Math.max(1, Math.floor(((c.lines.length - 1) * budget) / total)))
          let left = budget - counts.reduce((sum, n) => sum + n, 0)
          for (const [i, c] of chats.entries())
            if (left > 0 && counts[i]! < c.lines.length - 1) {
              counts[i]!++
              left--
            }
          expect(left).toBe(0)
          for (const [i, c] of chats.entries())
            writeFileSync(c.path, c.lines.slice(0, counts[i]! + 1).join("\n") + "\n")
          writeFileSync(
            join(work, "scale-fixture.json"),
            JSON.stringify({ cards: 422, chats: files.length, groups: 20, messages: budget }, null, 2)
          )
          writeFileSync(join(work, "scale-sized"), "complete\n")
        }
      }
      const scanned = await admin((api) => api.ScanStFolder({ path: folder }))
      const prefix = findStRoots(scanned.files.map((f) => f.path))[0]?.prefix
      expect(prefix, "synthetic fixture contains an ST user folder").toBeDefined()
      const job = await admin((api) => api.StartStPathImport({ path: scanned.root, prefix: prefix! }))
      await expect
        .poll(async () => (await admin((api) => api.GetStImport({ importId: job.importId }))).job.status, {
          timeout: 3_000_000,
          intervals: [2000, 5000]
        })
        .not.toBe("running")
      expect((await admin((api) => api.GetStImport({ importId: job.importId }))).job.status).toBe("complete")
      await admin((api) => api.SeenStImport({ importId: job.importId }))
      writeFileSync(join(work, "scale-import-complete"), "complete\n")
    }
    // Rich realistic cards, presets and books supplement the bulk scale fixture.
    if (!(await admin((api) => api.ListLibrary({ kind: "preset" }))).length) {
      const folder = writeRealisticStFolder(join(work, "synthetic-realistic"))
      const job = await admin((api) => api.StartStPathImport({ path: folder, prefix: "" }))
      await expect
        .poll(async () => (await admin((api) => api.GetStImport({ importId: job.importId }))).job.status, {
          timeout: 300_000,
          intervals: [1000, 3000]
        })
        .toBe("complete")
      await admin((api) => api.SeenStImport({ importId: job.importId }))
    }
    if (process.env.LAYOUT_AUDIT_SMALL !== "1") {
      // The archived dataset also has 43 books and 15 personas. The general scale
      // generator starts with fewer; bring the fallback up to that scale too.
      const books = await admin((api) => api.ListLibrary({ kind: "lorebook" }))
      for (let i = books.length; i < 43; i++) {
        const response = await fetch(`${server.url}/library/import?name=Layout%20world%20${i}.json`, {
          method: "POST",
          headers: { cookie, origin: server.url, "content-type": "application/octet-stream" },
          body: JSON.stringify({ entries: { "0": { uid: 0, key: ["harbour"], content: `Synthetic harbour ${i}.` } } })
        })
        expect(response.ok).toBe(true)
      }
      await admin((api) =>
        Effect.gen(function* () {
          const personas = (yield* api.ListCards()).filter((card) => card.persona).length
          for (let i = personas; i < 15; i++) {
            const card = yield* api.CreateCard({ label: `Layout persona ${i}`, name: `Layout persona ${i}` })
            yield* api.SetPersona({ entityId: card.entityId, persona: true })
          }
          expect((yield* api.ListCards()).filter((card) => card.persona).length).toBeGreaterThanOrEqual(15)
          expect((yield* api.ListLibrary({ kind: "lorebook" })).length).toBeGreaterThanOrEqual(43)
        })
      )
    }
    const seeded = await admin((api) =>
      Effect.gen(function* () {
        const cards = yield* api.ListLibrary({ kind: "card" })
        const a = cards.find((c) => c.label === "Aria Vance") ?? cards[0]!
        const b = cards.find((c) => c.entityId !== a.entityId)!
        const preset = (yield* api.ListLibrary({ kind: "preset" }))[0]!
        const book = (yield* api.ListLibrary({ kind: "lorebook" }))[0]!
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Layout model",
            baseUrl: provider.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          },
          apiKey: "sk-layout-synthetic-key"
        })
        const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
        yield* api.SetGenerationDefaults({
          defaults: { model: { connection: connection.id, model: model.id }, preset: null }
        })
        const started = yield* api.StartChat({
          cards: [a.entityId, b.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "A synthetic group gathers at the harbour.", speakerEntityId: null }
        })
        yield* api.ChangeCast({
          chatId: started.chat.id,
          slotId: null,
          change: { _tag: "Lorebook", ref: book.id, active: true }
        })
        yield* api.CreateChatNote({ chatId: started.chat.id, title: "Author's Note" })
        yield* api.CreateCardNote({
          cardRefId: a.id,
          title: "Character's Note",
          chatNote: { chatId: started.chat.id, slotId: null }
        })
        const reply = yield* api.Generate({
          chatId: started.chat.id,
          parentSlotId: started.entry.slotId,
          branch: false
        })
        if (reply._tag !== "Posted") throw new Error("fixture reply queued")
        yield* api.CreateFork({ chatId: started.chat.id, fromForkId: null, atSlotId: started.entry.slotId })
        return {
          chatId: started.chat.id,
          cardId: a.entityId,
          cardName: a.label,
          cardRef: a.id,
          presetRef: preset.id,
          bookRef: book.id,
          replyId: reply.entry.version.id,
          connectionId: connection.id,
          entries: (yield* api.ReadPath({
            chatId: started.chat.id,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 100
          })).entries
        }
      })
    )
    ;({ chatId, cardId, cardRef, presetRef, bookRef, replyId, connectionId, cardName } = seeded)
    await level1(
      join(work, "data"),
      chatId,
      seeded.entries.slice(0, Math.max(1, seeded.entries.length - 1)),
      "The group met by the harbour to read a synthetic ledger."
    )
  })
  test.afterAll(async () => {
    await server?.stop()
    await provider?.stop()
    if (!process.env.LAYOUT_AUDIT_WORK) rmSync(work, { recursive: true, force: true })
  })

  for (const width of [1440, 1024, 390])
    for (const theme of ["light", "dark"] as const) {
      test(`${width} ${theme}: all surfaces`, async ({ page }, info) => {
        test.setTimeout(1_800_000)
        page.setDefaultTimeout(15000)
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
        const findings: unknown[] = []
        const audit = async (surface: string) => {
          if (!selected.test(surface)) return
          await expect(page.getByRole("status").filter({ hasText: /^(Loading|Still loading)/ })).toHaveCount(0, {
            timeout: 30000
          })
          const inspect = async (suffix = "") => {
            const violations = await expectLayout(page, info, surface + suffix)
            console.log(`${width} ${theme} ${surface + suffix}: ${violations.length} violations`)
            findings.push({ surface: surface + suffix, violations })
            writeFileSync(join(work, `findings-${width}-${theme}.json`), JSON.stringify(findings, null, 2))
          }
          if (shots?.test(surface))
            await page.screenshot({
              path: join(work, "shots", `${width}-${theme}-${surface.replace(/\W+/g, "-")}.png`)
            })
          await inspect()
          await sampleScrollEnds(page, inspect)
        }
        const go = async (surface: string, path: string) => {
          await page.goto(`${server.url}${path}`)
          await expect(page.locator("main")).toBeVisible()
          await expect(page.getByRole("main").getByRole("heading").first()).toBeVisible({ timeout: 30000 })
          await audit(surface)
        }
        if (process.env.LAYOUT_AUDIT_CARD_HEADERS_ONLY === "1") {
          await go("card-editor-header", `/library/${cardRef}`)
          await go("card-page-header", `/cards/${cardId}`)
          await go("group-chat", `/chats/${chatId}`)
          await openPanel(page, cardName)
          await audit("panel-card-header")
          if (width >= 1024) {
            const handle = page.getByRole("separator", { name: "Resize chat panel", exact: true })
            await handle.press("Home")
            await audit("panel-card-header-narrow")
            await handle.press("End")
            await audit("panel-card-header-wide")
          }
          return
        }
        if (process.env.LAYOUT_AUDIT_DIALOGS_ONLY === "1") {
          await go("library-before-dialogs", "/library")
          for (const name of ["New card", "New prompt preset"]) {
            await page.getByRole("main").getByRole("button", { name, exact: true }).click()
            await expect(page.getByRole("dialog", { name, exact: true })).toBeVisible()
            await audit(`dialog-${name}`)
            await page.keyboard.press("Escape")
          }
          await go("card-before-large", `/library/${cardRef}`)
          await page.getByRole("button", { name: "Open Description large", exact: true }).click()
          const large = page.getByRole("dialog", { name: "Description", exact: true })
          await expect(large).toBeVisible()
          await audit("dialog-large-text")
          await page.keyboard.press("Escape")
          await go("chat-before-sheet", `/chats/${chatId}`)
          await openPanel(page, "This chat")
          if (width < 1024) await audit("dialog-panel-sheet")
          await closePanel(page)
          await page.getByRole("button", { name: "Chat actions", exact: true }).click()
          await page.getByRole("menuitem", { name: "Branches…", exact: true }).click()
          await expect(page.getByRole("dialog", { name: "Branches of this chat" })).toBeVisible()
          await audit("dialog-branches")
          await page.keyboard.press("Escape")
          await go("home-before-picker", "/")
          await showAppNavigation(page)
          if (width < 1024) await audit("dialog-navigation-drawer")
          await page.getByRole("button", { name: "Start a chat", exact: true }).click()
          await expect(page.getByRole("dialog", { name: "Start a chat with…", exact: true })).toBeVisible()
          await audit("dialog-start-chat-popover")
          return
        }
        if (process.env.LAYOUT_AUDIT_HEADER_ONLY === "1") {
          await go("pending-chat-header", `/cards/${cardId}/chat`)
          await go("saved-chat-header", `/chats/${chatId}`)
          return
        }
        if (process.env.LAYOUT_AUDIT_NOTES_ONLY === "1") {
          await go("group-chat", `/chats/${chatId}`)
          await openPanel(page, "Notes")
          await audit("panel-Notes")
          return
        }
        if (process.env.LAYOUT_AUDIT_PERSONA_TOGGLE_ONLY === "1") {
          const toggle = (scope: Page | Locator) => scope.getByRole("button", { name: "Include personas", exact: true })
          const checkRow = async (scope: Page | Locator) => {
            const button = toggle(scope)
            const direction = scope.getByRole("button", { name: /^Order:/ }).last()
            const a = (await button.boundingBox())!
            const b = (await direction.boundingBox())!
            expect(a.y).toBe(b.y)
            expect(a.width).toBe(b.width)
            expect(a.height).toBe(b.height)
            expect(a.x).toBeGreaterThan(b.x)
          }
          await go("home-all", "/")
          const main = page.getByRole("main")
          await checkRow(main)
          await toggle(main).click()
          await audit("home-include-personas")
          await showAppNavigation(page)
          await page
            .getByRole("group", { name: "Left panel", exact: true })
            .getByRole("button", { name: "Characters", exact: true })
            .click()
          const sideToggle = page.getByRole("button", { name: "Include personas", exact: true }).first()
          // The sidebar's grid is the first browser in document order.
          await expect(sideToggle).toBeVisible()
          await checkRow(sideToggle.locator(".."))
          await audit("sidebar-Characters")
          await sideToggle.click()
          await audit("sidebar-include-personas")
          if (width === 1440) {
            const handle = page.getByRole("separator", { name: "Resize sidebar", exact: true })
            const box = (await handle.boundingBox())!
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            await page.mouse.down()
            await page.mouse.move(0, box.y + box.height / 2, { steps: 10 })
            await page.mouse.up()
            await checkRow(sideToggle.locator(".."))
            await audit("sidebar-minimum-include-personas")
          }
          await hideAppNavigation(page)
          await go("group-chat", `/chats/${chatId}`)
          const cast = await openPanel(page, "Cast")
          const add = cast.getByRole("button", { name: "Add characters", exact: true })
          if ((await add.getAttribute("aria-expanded")) === "false") await add.click()
          const section = cast.getByRole("region", { name: "Add characters", exact: true })
          await checkRow(section)
          await audit("cast-add-characters")
          await toggle(section).click()
          await audit("cast-add-personas")
          return
        }
        if (process.env.LAYOUT_AUDIT_HOME_ONLY === "1") {
          await go("home-all", "/")
          return
        }
        if (process.env.LAYOUT_AUDIT_GRIDS_ONLY === "1") {
          await go("home-all", "/")
          await showAppNavigation(page)
          await page
            .getByRole("group", { name: "Left panel", exact: true })
            .getByRole("button", { name: "Characters", exact: true })
            .click()
          await audit("sidebar-Characters")
          await hideAppNavigation(page)
          await go("library-list", "/library")
          await page
            .getByRole("group", { name: "View", exact: true })
            .getByRole("button", { name: "Grid", exact: true })
            .click()
          await audit("library-grid")
          return
        }
        if (process.env.LAYOUT_AUDIT_FIXES_ONLY === "1") {
          await go("home-all", "/")
          await go("library", "/library")
          await go("settings-display", "/settings/display")
          await go("card-editor", `/library/${cardRef}`)
          for (const name of ["Greetings", "Metadata", "Lorebook", "Notes", "Extra"]) {
            await page.getByRole("main").getByRole("tab", { name, exact: true }).first().click()
            await audit(`card-editor-${name}`)
          }
          await go("group-chat", `/chats/${chatId}`)
          await openPanel(page, "Notes")
          await audit("panel-Notes")
          await closePanel(page)
          await page.getByRole("button", { name: "Chat actions", exact: true }).click()
          await page.getByRole("menuitem", { name: "Branches…", exact: true }).click()
          await expect(page.getByRole("dialog", { name: "Branches of this chat" })).toBeVisible()
          await audit("dialog-branches")
          return
        }
        await go("home-all", "/")
        for (const name of ["With chats", "Never used", "Favourites", "Personas", "Groups", "All"]) {
          await page
            .getByRole("main")
            .getByRole("group", { name: "Show", exact: true })
            .getByRole("button", { name, exact: true })
            .click()
          await audit(`home-${name}`)
        }
        // Personas mixed in, each marked "You" (personalists).
        if (selected.test("home-include-personas")) {
          const include = page.getByRole("main").getByRole("button", { name: "Include personas", exact: true })
          await include.click()
          await audit("home-include-personas")
          await include.click()
        }
        await showAppNavigation(page)
        for (const name of ["Characters", "Chats"]) {
          await page
            .getByRole("group", { name: "Left panel", exact: true })
            .getByRole("button", { name, exact: true })
            .click()
          await audit(`sidebar-${name}`)
        }
        await page.getByRole("button", { name: "Start a chat", exact: true }).click()
        await audit("dialog-start-chat")
        await page.keyboard.press("Escape")
        await hideAppNavigation(page)
        for (const [scope, query] of [
          ["all", ""],
          ["character", `&character=${cardId}`],
          ["branches", `&character=${cardId}&forks=${chatId}`]
        ]) {
          await page.goto(`${server.url}/?side=chats${query}`)
          await expect(page.getByRole("main").getByRole("heading").first()).toBeVisible({ timeout: 30000 })
          await showAppNavigation(page)
          await expect(page.getByRole("group", { name: "Left panel", exact: true })).toBeVisible()
          await audit(`sidebar-scope-${scope}`)
          await hideAppNavigation(page)
        }
        await go("group-chat", `/chats/${chatId}`)
        await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
        const sweep = async (suffix: string) => {
          for (const name of [
            "This chat",
            "Cast",
            "Model",
            "Prompt preset",
            "Notes",
            "Lorebooks",
            "Summaries",
            "Display",
            "Snippets",
            "History edits"
          ]) {
            const panel = await openPanel(page, name)
            await expect(panel.getByText(/^(Loading|Still loading)/)).toHaveCount(0, { timeout: 30000 })
            await audit(`panel-${name}${suffix}`)
            if (name === "Notes") {
              const insets = await panel.getByRole("switch").evaluateAll((switches) =>
                switches.map((control) => {
                  const block = control.closest("section")!
                  return control.getBoundingClientRect().left - block.getBoundingClientRect().left - block.clientLeft
                })
              )
              expect.soft(insets.length, "both chat and character notes are present").toBeGreaterThanOrEqual(2)
              for (const inset of insets) expect.soft(inset, "note switch inset").toBeGreaterThanOrEqual(8)
              await info.attach(`Notes${suffix}`, { body: await panel.screenshot(), contentType: "image/png" })
            }
            if (name === "Summaries") {
              await expect(panel.locator("[data-summary]").first()).toBeVisible({ timeout: 30000 })
              await openSummarySettings(page)
              await audit(`panel-summary-settings${suffix}`)
            }
          }
          const card = await openPanel(page, cardName)
          for (const name of ["Definition", "Greetings", "Metadata", "Lorebook", "Notes", "Extra"]) {
            await card.getByRole("tab", { name, exact: true }).first().click()
            await audit(`panel-card-${name}${suffix}`)
          }
          // The card's picture: its whole image in the viewer, and the Picture dialog (portraitview).
          const view = card.getByRole("button", { name: /^View .*'s picture$/ })
          if (selected.test(`portrait-viewer${suffix}`) && (await view.count()) > 0) {
            await view.first().click()
            await expect(page.locator("[data-image-viewer]").first()).toBeVisible()
            await audit(`portrait-viewer${suffix}`)
            await page.keyboard.press("Escape")
            await expect(page.locator("[data-image-viewer]")).toHaveCount(0)
          }
          if (selected.test(`dialog-picture${suffix}`) && (await view.count()) > 0) {
            await card.getByRole("button", { name: "Picture", exact: true }).click()
            await expect(page.locator("[data-cutout-box]")).toBeVisible()
            await audit(`dialog-picture${suffix}`)
            await page.keyboard.press("Escape")
            await expect(page.locator("[data-cutout-box]")).toHaveCount(0)
          }
        }
        await sweep("")
        if (width >= 1024) {
          const hideSidebar = page.getByRole("button", { name: "Hide the sidebar", exact: true })
          if (await hideSidebar.isVisible()) await hideSidebar.click()
          const handle = page.getByRole("separator", { name: "Resize chat panel", exact: true })
          const box = (await handle.boundingBox())!
          const before = Number(await handle.getAttribute("aria-valuenow"))
          await page.mouse.move(box.x + box.width / 2, box.y + 200)
          await page.mouse.down()
          await page.mouse.move(box.x - width, box.y + 200, { steps: 12 })
          await page.mouse.up()
          await expect.poll(async () => Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(before)
          await sweep("-wide-drag")
        }
        await closePanel(page)
        const routes: Array<[string, string]> = [
          ["chats", "/chats"],
          ["library", "/library"],
          ["card", `/cards/${cardId}`],
          ["card-editor", `/library/${cardRef}`],
          ["preset-editor", `/library/${presetRef}`],
          ["lorebook-editor", `/library/${bookRef}`],
          ...[
            "connections",
            "connections/new",
            `connections/${connectionId}`,
            "keys",
            "network",
            "costs",
            "chats",
            "display",
            "regex",
            "notifications",
            "account",
            "users",
            "status"
          ].map((section) => [`settings-${section}`, `/settings/${section}`] as [string, string]),
          ["import", "/import"],
          ["import-st", "/import/st"],
          ["bin", "/bin"],
          ["inspector", `/chats/${chatId}/context/${replyId}`]
        ]
        for (const [surface, path] of routes) {
          await go(surface, path)
          if (surface === "library") {
            for (const name of ["New card", "New prompt preset"]) {
              await page.getByRole("main").getByRole("button", { name, exact: true }).click()
              await expect(page.getByRole("dialog", { name, exact: true })).toBeVisible()
              await audit(`dialog-${name}`)
              await page.keyboard.press("Escape")
            }
            for (const name of ["Cards", "Presets", "Lorebooks"]) {
              const tab = page.getByRole("main").getByRole("tab", { name: new RegExp(`^${name}`) })
              await tab.click()
              await audit(`library-${name}`)
            }
          }
          if (surface === "card-editor")
            for (const name of ["Greetings", "Metadata", "Lorebook", "Notes", "Extra"]) {
              await page.getByRole("main").getByRole("tab", { name, exact: true }).first().click()
              await audit(`card-editor-${name}`)
            }
        }
        await go("users-before-dialog", "/settings/users")
        await page.getByRole("button", { name: "New user", exact: true }).click()
        await expect(page.getByRole("dialog", { name: "New user" })).toBeVisible()
        await audit("dialog-new-user")
        await page.keyboard.press("Escape")
        await go("keys-before-dialog", "/settings/keys")
        await page.getByRole("button", { name: "Replace key", exact: true }).first().click()
        await expect(page.getByRole("dialog")).toBeVisible()
        await audit("dialog-replace-key")
        await page.keyboard.press("Escape")
        await go("chat-before-dialogs", `/chats/${chatId}`)
        await page.getByRole("button", { name: "Chat actions", exact: true }).click()
        await audit("menu-chat-actions")
        await page.getByRole("menuitem", { name: "Branches…", exact: true }).click()
        await expect(page.getByRole("dialog", { name: "Branches of this chat" })).toBeVisible()
        await audit("dialog-branches")
        await page.keyboard.press("Escape")
      })
    }
})

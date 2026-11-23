// What a message says about itself (msgmeta, owner 2026-11-01): the model that wrote the
// shown version, with its lab's mark, in the header, changing as the versions are stepped
// through; the date and time; the number, generation time and tokens under the portrait, as
// ST shows them; a reply generated here showing the same; and the Interface settings hiding
// each. At 1440 and 390, in both themes. Synthetic ST files only.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { card, header, jsonl } from "../../server/test/support/stFolder.ts"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider

const shoot = async (page: Page, name: string) => {
  if (!process.env.SCREENSHOT_DIR) return
  mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `${name}.png`) })
}

const iso = (at: number) => new Date(at).toISOString()
const LAST_YEAR = Date.UTC(new Date().getUTCFullYear() - 1, 2, 1, 9, 0)
// The last reply was written a minute ago: its time shows alone.
const RECENT = Date.now() - 60_000

const swipeRecord = (end: number, seconds: number, extra: Record<string, unknown>) => ({
  send_date: iso(end),
  gen_started: iso(end - seconds * 1000),
  gen_finished: iso(end),
  extra
})
const openai = swipeRecord(RECENT - 120_000, 12, { api: "openai", model: "gpt-4o", token_count: 380 })
const claude = swipeRecord(RECENT, 8, { api: "claude", model: "claude-3-opus-20240229", token_count: 214 })

const chat = [
  header({}),
  {
    name: "Mira",
    is_user: false,
    send_date: iso(LAST_YEAR),
    mes: '*Mira looks up from the map.* "You\'re late."',
    swipe_id: 0,
    swipes: ['*Mira looks up from the map.* "You\'re late."'],
    swipe_info: [{ send_date: iso(LAST_YEAR), extra: {} }],
    extra: {}
  },
  {
    name: "Sam",
    is_user: true,
    send_date: iso(LAST_YEAR + 60_000),
    mes: '"The snow held me up." *Sam stamps his boots by the door.*',
    extra: { token_count: 17 }
  },
  {
    name: "Mira",
    is_user: false,
    mes: '*She folds the map into her coat.* "Then we leave at first light."',
    send_date: claude.send_date,
    gen_started: claude.gen_started,
    gen_finished: claude.gen_finished,
    extra: claude.extra,
    swipe_id: 1,
    swipes: [
      '*She taps the ridge on the map.* "We go over, not around."',
      '*She folds the map into her coat.* "Then we leave at first light."'
    ],
    swipe_info: [openai, claude]
  }
]

const lastReply = (page: Page) => page.getByRole("article", { name: "Reply" }).last()
const portrait = (message: Locator) => message.locator("[data-portrait-details]")
/** A tooltip showing this text (its hidden description copy left out). */
const tip = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true }).last()

/**
 * A lab's mark in a header: the logo from Simple Icons or LobeHub, named for its lab, filled
 * monochrome in the header's muted text colour.
 */
const expectMark = async (head: Locator, id: string, lab: string, source: "simple-icons" | "lobehub") => {
  const mark = head.locator(`[data-model-mark="${id}"]`)
  await expect(mark).toBeVisible()
  await expect(head.getByRole("img", { name: `${lab} model` })).toBeVisible()
  await expect(mark.locator("svg")).toHaveAttribute("data-mark-source", source)
  const paint = await mark.evaluate((span) => {
    const svg = getComputedStyle(span.querySelector("svg")!)
    return { color: getComputedStyle(span).color, fill: svg.fill }
  })
  expect(paint.fill).toBe(paint.color)
}

const themes = async (page: Page, each: (width: number, theme: string) => Promise<void>) => {
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.evaluate((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await page.reload()
      await each(width, theme)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    }
  await page.setViewportSize({ width: 1440, height: 900 })
}

test.setTimeout(240_000)

test.beforeAll(async () => {
  provider = await startProvider()
})
test.afterAll(async () => {
  await provider.stop()
})

test("a message shows its model with its lab's mark, its date and time, and its figures under the portrait", async ({
  page
}) => {
  const { importId } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local server",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-msgmeta-test-key"
      })
      yield* api.RefreshModels({ connectionId: connection.id })
      const model = (yield* api.ListModels({ connectionId: connection.id, includeHidden: false })).find(
        (m) => m.key === "fake-large"
      )!
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      return yield* api.StartStImport({ unsupported: [] })
    })
  )
  const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  const upload = async (path: string, body: Uint8Array) => {
    const response = await fetch(`${server().url}/st-import/file?${new URLSearchParams({ import: importId, path })}`, {
      method: "POST",
      headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
      body: new Uint8Array(body)
    })
    expect(response.status).toBe(200)
  }
  await upload("characters/Mira.png", card("Mira", '*Mira looks up from the map.* "You\'re late."'))
  await upload("chats/Mira/Pass.jsonl", jsonl(chat))
  const { id } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ListChats({ limit: 10, before: null }).pipe(Effect.map((chats) => chats.find((c) => c.title === "Pass")!))
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${server().url}/chats/${id}`)

  const reply = lastReply(page)
  const head = reply.locator("header")
  // The shown swipe: Anthropic's model (its Simple Icons logo), written a minute ago (the time
  // alone), 8 s and 214 tokens.
  await expectMark(head, "anthropic", "Anthropic", "simple-icons")
  await expect(head).toContainText("claude-3-opus-20240229")
  await expect(head.locator("time")).toHaveText(/^\d{1,2}[:.]\d{2}/)
  await expect(head.locator("time")).not.toContainText(String(new Date().getFullYear()))
  await expect(portrait(reply)).toHaveText(/#3\s*8\.0s\s*214t/)
  // The first message is from last year: its date, with the year, before its time.
  const first = page.getByRole("article").first()
  await expect(first.locator("header time")).toContainText(String(new Date(LAST_YEAR).getFullYear()))
  await expect(portrait(first)).toHaveText("#1")
  // The user's turn has ST's count, and no model or time.
  const turn = page.getByRole("article", { name: "Your message" })
  await expect(portrait(turn)).toHaveText(/#2\s*17t/)
  await expect(turn.locator("[data-model-mark]")).toHaveCount(0)

  // Each detail explains itself on hover.
  await head.locator('[data-model-mark="anthropic"]').hover()
  await expect(tip(page, "Anthropic's model claude-3-opus-20240229")).toBeVisible()
  await head.locator("time").hover()
  await expect(tip(page, /^Written /)).toBeVisible()
  await portrait(reply).getByText("#3").hover()
  await expect(tip(page, "Message 3")).toBeVisible()
  await portrait(reply)
    .getByRole("button", { name: /^Generation: 8\.0 s · 214 tokens/ })
    .hover()
  await expect(tip(page, "as imported: the text and its reasoning")).toBeVisible()
  await shoot(page, "01-imported-1440")

  // The other swipe: another lab, its own figures.
  await reply.hover()
  await reply.getByRole("button", { name: "Previous swipe" }).click()
  await expect(reply).toContainText("We go over, not around.")
  // OpenAI isn't in Simple Icons: our own drawing.
  await expectMark(head, "openai", "OpenAI", "lobehub")
  await expect(head).toContainText("OpenAI · gpt-4o")
  await expect(portrait(reply)).toHaveText(/#3\s*12\.0s\s*380t/)
  await shoot(page, "02-swiped-1440")

  await themes(page, async (width, theme) => {
    const shown = lastReply(page)
    await expectMark(shown.locator("header"), "openai", "OpenAI", "lobehub")
    await expect(portrait(shown)).toBeVisible()
    // Under the portrait, never wider than it.
    const column = (await portrait(shown).boundingBox())!
    const face = (await shown.locator(".chat-portrait").boundingBox())!
    expect(column.width).toBeLessThanOrEqual(face.width + 1)
    expect(column.y).toBeGreaterThan(face.y + face.height - 1)
    await shoot(page, `03-details-${width}-${theme}`)
    // The other swipe's logo in this theme, then back to where the loop found it.
    await shown.hover()
    await shown.getByRole("button", { name: "Next swipe" }).click()
    await expectMark(shown.locator("header"), "anthropic", "Anthropic", "simple-icons")
    await shoot(page, `03-logo-${width}-${theme}`)
    await shown.hover()
    await shown.getByRole("button", { name: "Previous swipe" }).click()
    await expect(shown).toContainText("We go over, not around.")
  })

  // A version generated here: its connection and model, and its time and tokens from the ledger.
  await reply.hover()
  await reply.getByRole("button", { name: "Next swipe" }).click()
  await reply.hover()
  await reply.getByRole("button", { name: "Generate another swipe" }).click()
  await expect(reply).toContainText("The bridge holds.")
  await expect(reply.getByText("generating", { exact: true })).toHaveCount(0)
  await expect(head).toContainText("fake-large")
  await expect(head.locator('[data-model-mark="generic"]')).toBeVisible()
  await expect(portrait(reply)).toHaveText(/#3\s*\d+\.\ds\s*6t/)
  await shoot(page, "04-generated-1440")

  // The Interface settings hide each detail, on every message.
  await page.goto(`${server().url}/settings/interface`)
  const details = page.getByRole("group", { name: "Message details" })
  for (const name of ["Date and time", "Model icon", "Model name", "Message number", "Generation time", "Token count"])
    await expect(details.getByRole("switch", { name })).toBeChecked()
  await expect(details.getByRole("switch", { name: "Model icon", exact: true })).toHaveAccessibleDescription(
    "The mark of the lab whose model wrote a reply, before the model's name."
  )
  await details.getByRole("button", { name: "About Model icon", exact: true }).hover()
  await expect(tip(page, "The mark of the lab")).toBeVisible()
  await shoot(page, "05-settings-1440")
  for (const name of ["Date and time", "Model icon", "Message number", "Generation time", "Token count"]) {
    await details.getByRole("switch", { name }).click()
    await expect(details.getByRole("switch", { name })).not.toBeChecked()
  }
  await expect
    .poll(
      async () =>
        Object.keys(
          (await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.GetDisplayPrefs({}))).messageDetails
        ).length
    )
    .toBe(5)
  await page.goto(`${server().url}/chats/${id}`)
  await expect(lastReply(page)).toContainText("The bridge holds.")
  await expect(page.locator("article header time")).toHaveCount(0)
  await expect(page.locator("article [data-model-mark]")).toHaveCount(0)
  await expect(lastReply(page).locator("header")).toContainText("fake-large")
  await expect(page.locator("article [data-portrait-details]:not(:empty)")).toHaveCount(0)
  await shoot(page, "06-hidden-1440")
  await page.setViewportSize({ width: 390, height: 900 })
  await page.reload()
  await expect(lastReply(page)).toContainText("The bridge holds.")
  await expect(page.locator("article [data-portrait-details]:not(:empty)")).toHaveCount(0)
  await shoot(page, "07-hidden-390")
})

// The full connection gets the actual free header width, never a one-letter stub.
test("model labels use the free header width and hide the whole connection when needed", async ({ page }, info) => {
  const model = "acme.deepseek/deepseek-v4.1-flash-1017"
  const full = `Custom · ${model}`
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SetDisplayPrefs({
      prefs: {
        messageDetails: {
          "message.time": true,
          "message.model-icon": true,
          "message.model": true,
          "message.number": true,
          "message.timer": true,
          "message.tokens": true
        }
      }
    })
  )
  const { importId } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.StartStImport({ unsupported: [] })
  )
  const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  for (const [path, body] of [
    ["characters/Label.png", card("Label", "A synthetic greeting.")],
    [
      "chats/Label/Model label.jsonl",
      jsonl([
        header({ integrity: "11111111-1111-4111-8111-111111111111" }),
        chat[1],
        chat[2],
        {
          name: "Label",
          is_user: false,
          mes: "A synthetic reply.",
          send_date: iso(RECENT),
          extra: { api: "custom", model }
        }
      ])
    ]
  ] as const) {
    const response = await fetch(`${server().url}/st-import/file?${new URLSearchParams({ import: importId, path })}`, {
      method: "POST",
      headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
      body: new Uint8Array(body)
    })
    expect(response.status).toBe(200)
  }
  const { id } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api
      .ListChats({ limit: 10, before: null })
      .pipe(Effect.map((chats) => chats.find((c) => c.title === "Model label")!))
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${id}`)
  for (const width of [1440, 390, 320, 1440]) {
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.evaluate((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await page.reload()
      const head = lastReply(page).locator("header")
      const label = head.locator("[data-model-label]")
      await expect(label).toBeVisible()
      const connection = label
        .locator("span")
        .filter({ hasText: /^Custom ·\s*$/ })
        .last()
      const geometry = await label.evaluate((element) => {
        const full = element.firstElementChild!
        const shown = element.lastElementChild!
        const model = shown.lastElementChild!
        return {
          available: element.getBoundingClientRect().width,
          full: full.getBoundingClientRect().width,
          model: model.clientWidth,
          modelFull: model.scrollWidth,
          height: element.getBoundingClientRect().height
        }
      })
      await info.attach(`label-${width}-${theme}`, { body: JSON.stringify(geometry), contentType: "application/json" })
      await expect(connection).toBeVisible({ visible: geometry.full <= geometry.available })
      if (width === 1440) {
        expect(geometry.full).toBeLessThanOrEqual(geometry.available)
        expect(geometry.modelFull).toBeLessThanOrEqual(geometry.model)
        expect(geometry.full).toBeGreaterThan(256)
      }
      // The old label showed a clipped connection at this precise available width.
      // Constrain only this label, leaving room for the model and one connection letter. On a
      // phone the label takes what the time's line leaves (it never starts a line of its own),
      // so the width is set exactly, not only capped.
      if (width === 320) {
        const before = await head.boundingBox()
        await label.evaluate((element, max) => {
          element.style.maxWidth = `${max}px`
          element.style.minWidth = `${max}px`
        }, geometry.modelFull + 10)
        await expect(connection).toBeHidden()
        await expect
          .poll(() =>
            label.evaluate((element) => {
              const model = element.lastElementChild!.lastElementChild!
              return model.scrollWidth <= model.clientWidth
            })
          )
          .toBe(true)
        await label.evaluate((element, max) => {
          element.style.maxWidth = `${max}px`
          element.style.minWidth = `${max}px`
        }, geometry.modelFull / 2)
        await expect(connection).toBeHidden()
        await expect
          .poll(() =>
            label.evaluate((element) => {
              const model = element.lastElementChild!.lastElementChild!
              return model.scrollWidth > model.clientWidth
            })
          )
          .toBe(true)
        await label.evaluate((element) => {
          element.style.maxWidth = ""
          element.style.minWidth = ""
        })
        await expect(connection).toBeVisible({ visible: geometry.full <= geometry.available })
        expect((await head.boundingBox())!.height).toBe(before!.height)
      }
      await label.hover()
      await expect(tip(page, `Generated with ${full}, as recorded at import`)).toBeVisible()
      await page.mouse.move(0, 0)
      await expect(tip(page, `Generated with ${full}, as recorded at import`)).toHaveCount(0)
      if (process.env.SCREENSHOT_DIR) {
        mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
        await head.screenshot({ path: join(process.env.SCREENSHOT_DIR, `model-label-${width}-${theme}.png`) })
      }
      if (process.env.LAYOUT_AUDIT)
        await expectLayout(page, info, `model-label-${width}-${theme}`, { scope: "article header" })
    }
  }
})

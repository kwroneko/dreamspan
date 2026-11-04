// Four card header rows stay within the portrait at normal widths; identity controls may wrap at the panel minimum.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, test } from "@playwright/test"
import { Effect } from "effect"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile(withAdmin)
let cookie = ""
let chat = ""
const cards: Array<{ id: string; entityId: string; name: string; version: string; nickname: string }> = []
const work = process.env.SCREENSHOT_DIR
const audit = process.env.HEADER_AUDIT === "1"
const OFF = "Mark this card as a persona: a card you play as, listed under Personas."
const ON = "Remove the persona mark: this becomes a regular card again."
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  await withCookie(server(), cookie, (api) =>
    Effect.gen(function* () {
      const started = yield* api.CreateChat({ title: "Four header rows" })
      chat = started.id
      for (const [name, version, nickname] of [
        ["Mio", "Winter 2.1", "Mio-chan"],
        ["Wren", "", ""],
        [
          "Seraphina Valentina Montgomery-Blackwood of the Silver Marches",
          "Extended edition of the northern lighthouse chronicles",
          "Lady Seraphina of the never-ending eastern sea"
        ]
      ]) {
        const card = yield* api.CreateCard({ label: name!, name: name!, version: version!, nickname: nickname! })
        cards.push({ id: card.id, entityId: card.entityId, name: name!, version: version!, nickname: nickname! })
        yield* api.ChangeCast({ chatId: started.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      }
      yield* api.SendMessage({
        chatId: started.id,
        parentSlotId: null,
        branch: false,
        content: "A synthetic harbour scene.",
        reply: false
      })
    })
  )
})

async function countsOrder(usage: Locator, hasChats: boolean) {
  await expect(usage).toHaveText(hasChats ? /^.+ tokens · .+ permanent1 chat$/ : /^.+ tokens · .+ permanent$/)
  expect(await usage.locator(":scope > *").evaluateAll((children) => children.map((child) => child.tagName))).toEqual(
    hasChats ? ["SPAN", "A"] : ["SPAN"]
  )
  const separators = await usage
    .locator(":scope > *")
    .evaluateAll((children) => children.map((child) => getComputedStyle(child, "::after").content))
  expect(separators).toEqual(hasChats ? ['"·"', "none"] : ["none"])
}

async function structure(header: Locator, panel = true, allowWrap = false) {
  expect(
    await header.evaluate((root) =>
      [...root.children].map((child) =>
        child.hasAttribute("data-card-header-portrait") || child.querySelector("[data-card-header-portrait]")
          ? "portrait"
          : child.hasAttribute("data-card-header-rows")
            ? "rows"
            : "unexpected"
      )
    )
  ).toEqual(["portrait", "rows"])
  const rows = header.locator("[data-card-header-rows]")
  expect(
    await rows
      .locator(":scope > *")
      .evaluateAll((children) => children.map((row) => row.getAttribute("data-card-header-row")))
  ).toEqual(["identity", "nickname", "persona", "usage"])
  const geometry = await header.evaluate((root) => {
    const box = (element: Element) => {
      const b = element.getBoundingClientRect()
      return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, height: b.height }
    }
    const portrait = box(root.querySelector("[data-card-header-portrait]")!)
    const stack = root.querySelector("[data-card-header-rows]")!
    return { header: box(root), portrait, stack: box(stack), rows: [...stack.children].map(box) }
  })
  if (allowWrap) {
    expect(geometry.header.height).toBeCloseTo(Math.max(geometry.portrait.height, geometry.stack.height), 0)
  } else {
    expect(geometry.header.height).toBeLessThanOrEqual(geometry.portrait.height + 1)
    expect(geometry.stack.bottom).toBeLessThanOrEqual(geometry.portrait.bottom + 1)
  }
  expect(geometry.stack.y).toBeCloseTo(geometry.portrait.y, 0)
  for (const row of geometry.rows) {
    expect(row.x).toBeGreaterThanOrEqual(geometry.portrait.right)
    expect(row.right).toBeLessThanOrEqual(geometry.header.right + 1)
  }
  for (let i = 1; i < geometry.rows.length; i++)
    expect(geometry.rows[i]!.y - geometry.rows[i - 1]!.bottom).toBeCloseTo(4, 0)
  if (panel) {
    const rhythm = await header.evaluate((root) => {
      const row = (name: string) => root.querySelector(`[data-card-header-row="${name}"]`)!.getBoundingClientRect()
      const icon = root.querySelector<SVGSVGElement>('[data-card-header-row="persona"] button svg')!
      const svg = icon.getBoundingClientRect()
      // The person path starts at x=4 with a 2-unit round stroke in a 24-unit viewBox.
      return {
        left: svg.x + (3 / 24) * svg.width,
        boxLeft: icon.parentElement!.getBoundingClientRect().x,
        textLeft: row("nickname").x,
        heights: [row("nickname").height, row("usage").height, row("persona").height]
      }
    })
    expect(rhythm.left).toBeCloseTo(
      rhythm.textLeft +
        ((await header.getByRole("button", { name: "Persona", exact: true }).getAttribute("aria-pressed")) === "true"
          ? 10
          : 0),
      0
    )
    expect(rhythm.boxLeft).toBeCloseTo(rhythm.textLeft, 0)
    expect(rhythm.heights[0]).toBe(28)
    expect(rhythm.heights[1]).toBe(16)
    expect(rhythm.heights[2]).toBeGreaterThanOrEqual(28)
    const toggle = header.getByRole("button", { name: "Persona", exact: true })
    const bounds = (await toggle.boundingBox())!
    const nickname = (await header.locator('[data-card-header-row="nickname"]').boundingBox())!
    const counts = (await header.locator('[data-card-header-row="usage"]').boundingBox())!
    expect(bounds.y - nickname.y - nickname.height).toBeGreaterThanOrEqual(4)
    expect(counts.y - bounds.y - bounds.height).toBeGreaterThanOrEqual(4)
    expect(bounds.y + bounds.height / 2).toBeCloseTo((nickname.y + nickname.height + counts.y) / 2, 0)
    if (!allowWrap) expect(counts.y + counts.height).toBeCloseTo(geometry.portrait.bottom, 0)
    expect(bounds.height).toBe(28)
    expect(bounds.width).toBe((await toggle.getAttribute("aria-pressed")) === "true" ? 88 : 32)
  }
}

for (const width of [390, 1024, 1440])
  for (const theme of ["light", "dark"] as const)
    for (const view of ["panel", "full"] as const)
      test(`four card header rows: ${view}, ${width}, ${theme}`, async ({ page }, info) => {
        test.setTimeout(180_000)
        await page.setViewportSize({ width, height: 1000 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((theme) => localStorage.setItem("rp.theme", theme), theme)
        const separator = cookie.indexOf("=")
        await page
          .context()
          .addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: server().url }])
        for (const [index, card] of cards.entries()) {
          await page.goto(view === "full" ? `${server().url}/library/${card.id}` : `${server().url}/chats/${chat}`)
          const scope = view === "full" ? page.getByRole("main") : await openPanel(page, card.name)
          const header = scope.locator("[data-card-header]")
          await expect(header.locator("[data-card-tokens]")).toBeVisible()
          await structure(header, view === "panel")
          const identity = header.locator('[data-card-header-row="identity"]')
          await expect(identity.getByRole("heading", { name: card.name, exact: true })).toBeVisible()
          await expect(identity.locator("[data-card-version]")).toHaveText(card.version || "Add a version")
          await expect(header.locator('[data-card-header-row="nickname"]')).toContainText(
            card.nickname || "Add an in-chat nickname"
          )
          if (width === 390 && index === 0) {
            // The active rename needs room for its input and both buttons, even beside
            // the favourite and revision controls. A covered Cancel used to time out.
            for (const [label, field] of [
              ["the display name", "Display name"],
              ["the version", "Version"],
              ["the nickname", "In-chat nickname"]
            ] as const) {
              for (const action of ["Save the name", "Cancel renaming"]) {
                await header.getByRole("button", { name: `Rename ${label}`, exact: true }).click()
                const input = header.getByRole("textbox", { name: field, exact: true })
                await expect(input).toBeEditable()
                await header.getByRole("button", { name: action, exact: true }).click()
                await expect(input).toHaveCount(0)
              }
            }
          }
          const save = identity.getByRole("group", { name: "Save", exact: true })
          const at = (await save.boundingBox())!,
            row = (await identity.boundingBox())!
          const end =
            view === "panel"
              ? (await identity
                  .getByRole("button", { name: `Open ${card.name} in the full editor`, exact: true })
                  .boundingBox())!
              : at
          expect(row.x + row.width - end.x - end.width).toBeLessThanOrEqual(1)
          const usage = header.locator('[data-card-header-row="usage"]')
          await expect(usage.getByRole("link", { name: "1 chat", exact: true })).toBeVisible()
          await countsOrder(usage, true)
          await expect(scope.getByRole("button", { name: "Switch persona", exact: true })).toHaveCount(0)
          const toggle = header.getByRole("button", { name: "Persona", exact: true })
          await expect(toggle).toHaveAttribute("aria-pressed", "false")
          await expect(toggle).toHaveAccessibleDescription(OFF)
          await toggle.hover()
          await expect(page.getByText(OFF, { exact: true }).filter({ visible: true })).toBeVisible()
          await expect(toggle).toHaveCSS("transition-property", "none")
          if (width === 1440 && view === "full" && index === 0) {
            await page.emulateMedia({ reducedMotion: "no-preference" })
            await expect(toggle).toHaveCSS("transition-duration", "0.15s")
            await expect(toggle).toHaveCSS("transition-property", /width/)
          }
          const captureStates = async (persona: boolean) => {
            if (!work || view !== "panel" || index !== 0) return
            mkdirSync(work, { recursive: true })
            for (const state of ["rest", "hover", "focus"]) {
              await toggle.evaluate((el) => el.blur())
              await page.mouse.move(0, 0)
              if (state === "hover") await toggle.hover()
              if (state === "focus") {
                await toggle.focus()
                await page.keyboard.press("Tab")
                await page.keyboard.press("Shift+Tab")
                await expect(toggle).toBeFocused()
                expect(await toggle.evaluate((el) => el.matches(":focus-visible"))).toBe(true)
                await expect(toggle).toHaveCSS("--tw-ring-inset", "inset")
                await expect(toggle).toHaveCSS("--tw-ring-offset-width", "0px")
              }
              if (!persona) await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
              await expect(toggle).toHaveCSS("cursor", "pointer")
              await structure(header)
              const measured = await header.evaluate((root) => {
                const row = (name: string) =>
                  root.querySelector(`[data-card-header-row="${name}"]`)!.getBoundingClientRect()
                const button = root.querySelector<HTMLButtonElement>('[data-card-header-row="persona"] button')!
                const svg = button.querySelector("svg")!.getBoundingClientRect()
                return {
                  nameLeft: row("identity").x,
                  nicknameLeft: row("nickname").x,
                  countsLeft: row("usage").x,
                  boxLeft: button.getBoundingClientRect().x,
                  iconLeft: svg.x + (svg.width * 3) / 24,
                  focusShadow: getComputedStyle(button).boxShadow,
                  portraitBottom: root.querySelector("[data-card-header-portrait]")!.getBoundingClientRect().bottom,
                  countsBottom: row("usage").bottom,
                  availableCentre: (row("nickname").bottom + row("usage").top) / 2,
                  toggleCentre: button.getBoundingClientRect().top + button.getBoundingClientRect().height / 2,
                  background: getComputedStyle(button).backgroundColor,
                  cursor: getComputedStyle(button).cursor,
                  gaps: [
                    row("nickname").top - row("identity").bottom,
                    row("persona").top - row("nickname").bottom,
                    row("usage").top - row("persona").bottom
                  ]
                }
              })
              const file = join(work, `states-${width}-${theme}-${persona ? "persona" : "character"}-${state}`)
              writeFileSync(`${file}.json`, JSON.stringify(measured, null, 2))
              await header.screenshot({ path: `${file}.png` })
            }
            await toggle.evaluate((el) => el.blur())
            await page.mouse.move(0, 0)
          }
          await captureStates(false)
          const off = (await toggle.boundingBox())!
          await toggle.click()
          await expect(toggle).toHaveAttribute("aria-pressed", "true")
          if (view === "panel") await expect(header.locator("[data-persona-badge]")).toHaveCount(0)
          else await expect(header.locator("[data-persona-badge]")).toHaveText("Persona")
          await captureStates(true)
          await expect(toggle).toHaveAccessibleDescription(ON)
          await expect(toggle).toBeEnabled()
          await page.mouse.move(0, 0)
          await toggle.hover()
          await expect(page.getByText(ON, { exact: true }).filter({ visible: true })).toBeVisible()
          await expect.poll(async () => (await toggle.boundingBox())!.width).toBeGreaterThan(off.width)
          await expect(toggle.locator("span").filter({ hasText: "Persona" })).toHaveCSS("opacity", "1")
          await structure(header, view === "panel")
          await expect(toggle).toBeEnabled()
          if (work) {
            mkdirSync(work, { recursive: true })
            await page.mouse.move(0, 0)
            await header.screenshot({ path: join(work, `header-${view}-${width}-${theme}-${index}-persona.png`) })
          }
          if (audit) {
            await header.evaluate((el) => el.setAttribute("data-header-under-test", ""))
            await expectLayout(page, info, `header-${view}-${width}-${theme}-${index}`, {
              scope: "[data-header-under-test]"
            })
          }
          await toggle.click()
          await expect(toggle).toHaveAttribute("aria-pressed", "false")
          await expect(toggle).toBeEnabled()
          await expect.poll(async () => (await toggle.boundingBox())!.width).toBe(off.width)
          await structure(header, view === "panel")
          await page.emulateMedia({ reducedMotion: "reduce" })
          if (work) await header.screenshot({ path: join(work, `header-${view}-${width}-${theme}-${index}.png`) })
        }
      })

test("the default persona badge shares the bottom row at the panel minimum", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const card = cards[0]!
  await withCookie(server(), cookie, (api) =>
    Effect.gen(function* () {
      yield* api.SetPersona({ entityId: card.entityId as never, persona: true })
      yield* api.ChangeGenerationDefaults({ change: { persona: card.entityId as never } })
    })
  )
  const separator = cookie.indexOf("=")
  await page
    .context()
    .addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: server().url }])
  try {
    await page.goto(`${server().url}/chats/${chat}`)
    const panel = await openPanel(page, card.name)
    const header = panel.locator("[data-card-header]")
    await expect(header.locator("[data-card-tokens]")).toBeVisible()
    await page.getByRole("separator", { name: "Resize chat panel", exact: true }).press("Home")
    const row = header.locator('[data-card-header-row="persona"]')
    const toggle = row.getByRole("button", { name: "Persona", exact: true })
    const badge = row.locator("[data-default-persona]")
    await expect(toggle).toHaveAttribute("aria-pressed", "true")
    await expect(badge).toHaveText("Default")
    await expect(header.locator("[data-persona-badge]")).toHaveCount(0)
    await withCookie(server(), cookie, (api) =>
      api.ChangeCast({
        chatId: chat as never,
        slotId: null,
        change: { _tag: "Persona", entityId: card.entityId as never }
      })
    )
    await expect(header.locator("[data-persona-badge]")).toHaveText("You")
    await structure(header, true, true)
    if (work) {
      mkdirSync(work, { recursive: true })
      const measured = await header.evaluate((root) => {
        const box = (selector: string) => root.querySelector(selector)!.getBoundingClientRect()
        const portrait = box("[data-card-header-portrait]")
        const nickname = box('[data-card-header-row="nickname"]')
        const counts = box('[data-card-header-row="usage"]')
        const toggle = box('[data-card-header-row="persona"] button')
        return {
          portraitBottom: portrait.bottom,
          countsBottom: counts.bottom,
          toggleCentre: toggle.top + toggle.height / 2,
          availableCentre: (nickname.bottom + counts.top) / 2,
          gaps: [toggle.top - nickname.bottom, counts.top - toggle.bottom]
        }
      })
      writeFileSync(join(work, "minimum-measurements.json"), JSON.stringify(measured, null, 2))
    }

    for (const label of ["the display name", "the version"]) {
      await header.getByRole("button", { name: `Rename ${label}`, exact: true }).click()
      await header.getByRole("button", { name: "Cancel renaming", exact: true }).click()
    }
    const bounds = (await row.boundingBox())!,
      button = (await toggle.boundingBox())!,
      label = (await badge.boundingBox())!
    expect(label.x).toBeGreaterThanOrEqual(button.x + button.width)
    expect(label.x + label.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1)
    if (work) {
      mkdirSync(work, { recursive: true })
      await header.screenshot({ path: join(work, "header-default-persona-minimum.png") })
    }
    if (audit) {
      await header.evaluate((el) => el.setAttribute("data-header-under-test", ""))
      await expectLayout(page, info, "header-default-persona-minimum", { scope: "[data-header-under-test]" })
    }
  } finally {
    await withCookie(server(), cookie, (api) =>
      Effect.gen(function* () {
        yield* api.ChangeGenerationDefaults({ change: { persona: null } })
        yield* api.SetPersona({ entityId: card.entityId as never, persona: false })
      })
    )
  }
})

for (const width of [1440, 390])
  test(`optional chats count: ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    const fixture = await withCookie(server(), cookie, (api) =>
      Effect.gen(function* () {
        const card = yield* api.CreateCard({ label: `Counts ${width}`, name: `Counts ${width}` })
        const chat = yield* api.CreateChat({ title: `Counts ${width}` })
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
        return { card, chat }
      })
    )
    const separator = cookie.indexOf("=")
    await page
      .context()
      .addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: server().url }])
    for (const hasChats of [false, true]) {
      if (hasChats)
        await withCookie(server(), cookie, (api) =>
          api.SendMessage({
            chatId: fixture.chat.id,
            parentSlotId: null,
            branch: false,
            content: "Synthetic scene.",
            reply: false
          })
        )
      for (const view of ["panel", "full"] as const) {
        await page.goto(
          view === "panel" ? `${server().url}/chats/${fixture.chat.id}` : `${server().url}/library/${fixture.card.id}`
        )
        const scope = view === "panel" ? await openPanel(page, `Counts ${width}`) : page.getByRole("main")
        const header = scope.locator("[data-card-header]")
        const usage = header.locator('[data-card-header-row="usage"]')
        await expect(usage.locator("[data-card-tokens]")).toBeVisible()
        await expect(usage.getByRole("link")).toHaveCount(hasChats ? 1 : 0)
        for (const persona of [false, true]) {
          const toggle = header.getByRole("button", { name: "Persona", exact: true })
          if ((await toggle.getAttribute("aria-pressed")) !== String(persona)) await toggle.click()
          await expect(toggle).toHaveAttribute("aria-pressed", String(persona))
          await countsOrder(usage, hasChats)
          await page.mouse.move(0, 0)
          if (work) {
            mkdirSync(work, { recursive: true })
            await header.screenshot({
              path: join(
                work,
                `counts-${width}-${view}-${persona ? "persona" : "character"}-${hasChats ? "chats" : "no-chats"}.png`
              )
            })
          }
          if (audit)
            await expectLayout(page, info, `counts-${width}-${view}-${persona}-${hasChats}`, {
              scope: "[data-card-header]"
            })
        }
        // Leave the next view in the initial character state.
        await header.getByRole("button", { name: "Persona", exact: true }).click()
      }
    }
  })

// Composer spacing and labels, with synthetic cast and history only.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, test } from "@playwright/test"
import { Effect } from "effect"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "20" })
const longName = "Captain Alexandra Rhee of the Northern Expedition"
const shots = process.env.RP_SCREENS
let cookie: string
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})

const measure = (row: Locator) =>
  row.evaluate((node) => {
    const controls = [...node.querySelectorAll<HTMLElement>("button, [role=switch]")]
      .filter((el) => el.getBoundingClientRect().width > 0 && el.getAttribute("aria-label") !== "Keyboard shortcuts")
      .map((el) => {
        const { x, y, width, height } = el.getBoundingClientRect()
        return { label: el.getAttribute("aria-label"), x, y, width, height, centre: y + height / 2 }
      })
    return {
      controls,
      gaps: controls.slice(1).map((control, i) => control.x - controls[i]!.x - controls[i]!.width)
    }
  })

for (const width of [1440, 1024, 390])
  for (const theme of ["light", "dark"] as const)
    test(`equal composer gaps and aligned controls (${width}px ${theme})`, async ({ page }) => {
      const chatId = await withCookie(server(), cookie, (api) =>
        Effect.gen(function* () {
          yield* api.SetDisplayPrefs({ prefs: { guidance: false } })
          const speaker = (yield* api.CreateCard({ label: `${longName} ${width} ${theme}`, name: longName })).entityId
          const recent = (yield* api.CreateCard({ label: `Mira ${width} ${theme}`, name: "Mira" })).entityId
          const chat = yield* api.CreateChat({ title: "The expedition — synthetic spacing fixture" })
          for (const entityId of [speaker, recent])
            yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [speaker] } })
          yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            speakerEntityId: recent,
            content: "Mira studies the map. The northern passage is clear."
          })
          return chat.id
        })
      )
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chatId}`)
      const generate = page.getByRole("button", {
        name: `Generate ${longName}`,
        exact: true
      })
      await expect(generate).toBeEnabled()
      const controls = page.getByTestId("composer-controls")
      const strip = page.getByRole("group", { name: "Next reply", exact: true })
      const guidance = page.getByRole("switch", { name: "Guidance", exact: true })
      const measurements = []
      for (const on of [false, true]) {
        if (on) await guidance.click()
        await expect(guidance).toHaveAttribute("aria-checked", String(on))
        await page
          .getByTestId("composer")
          .fill(on ? "Let the captain discover a sheltered route." : "The pass is open.")
        const groups = [
          await measure(controls.locator(":scope > div").nth(0)),
          await measure(controls.locator(":scope > div").nth(1)),
          await measure(strip)
        ]
        const frame = (await page.getByTestId("composer-box").boundingBox())!
        measurements.push({ on, groups, frame })
        if (shots) {
          mkdirSync(shots, { recursive: true })
          const name = `${width}-${theme}-guidance-${on ? "on" : "off"}`
          await page.screenshot({ path: join(shots, `${name}.png`), animations: "disabled" })
          await page
            .locator(".chat-column")
            .filter({ has: controls })
            .screenshot({ path: join(shots, `${name}-composer.png`), animations: "disabled" })
        }
        for (const group of groups) {
          expect(group.controls.length).toBeGreaterThan(1)
          for (const gap of group.gaps) expect(Math.abs(gap - 6)).toBeLessThanOrEqual(1)
          for (const control of group.controls) {
            expect(Math.abs(control.height - 36)).toBeLessThanOrEqual(1)
            expect(Math.abs(control.centre - group.controls[0]!.centre)).toBeLessThanOrEqual(1)
          }
        }
        for (const control of groups[0]!.controls.slice(1)) expect(Math.abs(control.width - 36)).toBeLessThanOrEqual(1)
        for (const control of groups[1]!.controls.filter(
          (control) => !control.label?.startsWith("Generate") || width === 390
        ))
          expect(Math.abs(control.width - 36)).toBeLessThanOrEqual(1)
        // Both groups in the box share their centre; the pickers have the same outer inset.
        expect(Math.abs(groups[0]!.controls[0]!.centre - groups[1]!.controls[0]!.centre)).toBeLessThanOrEqual(1)
        expect(Math.abs(groups[0]!.controls[0]!.x - frame.x - 5)).toBeLessThanOrEqual(1)
        const last = groups[1]!.controls.at(-1)!
        expect(Math.abs(frame.x + frame.width - last.x - last.width - 5)).toBeLessThanOrEqual(1)
        expect(Math.abs(groups[2]!.controls[0]!.x - frame.x - 5)).toBeLessThanOrEqual(1)
        expect(
          await strip.evaluate(
            (el) => parseFloat(getComputedStyle(el).paddingRight) + parseFloat(getComputedStyle(el).borderRightWidth)
          )
        ).toBe(5)
        await expect(generate).toHaveText(width === 390 ? "" : "Generate")
        await guidance.focus()
        await page.keyboard.press("Tab")
        await expect(generate).toBeFocused()
        await expect(page.getByText(new RegExp(`^Generate ${longName}'s next turn`))).toBeVisible()
        await page.getByTestId("composer").focus()
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
      }
      if (shots)
        writeFileSync(join(shots, `${width}-${theme}-measurements.json`), JSON.stringify(measurements, null, 2))
      if (width === 1440 && theme === "light") {
        // Adding another possible replier exposes Next and its icon-only Reply now control.
        await withCookie(server(), cookie, (api) =>
          Effect.gen(function* () {
            const entityId = (yield* api.CreateCard({ label: "Wren spacing fixture", name: "Wren" })).entityId
            yield* api.ChangeCast({ chatId, slotId: null, change: { _tag: "Join", entityId } })
          })
        )
        const replyNow = strip.getByRole("button", { name: /replies now$/ })
        await expect(replyNow).toBeVisible()
        const full = await measure(strip)
        for (const gap of full.gaps) expect(Math.abs(gap - 6)).toBeLessThanOrEqual(1)
        for (const control of full.controls) {
          expect(Math.abs(control.height - 36)).toBeLessThanOrEqual(1)
          expect(Math.abs(control.centre - full.controls[0]!.centre)).toBeLessThanOrEqual(1)
        }
        expect((await replyNow.boundingBox())!.width).toBe(36)
      }
      if (width === 1440) {
        // The lone portrait is a real recent-speaker control: its explanation and action agree.
        const recent = page.getByRole("button", { name: "Speak as Mira", exact: true })
        await recent.focus()
        await page.keyboard.press("Shift+Tab")
        await page.keyboard.press("Tab")
        await expect(page.getByText("Switch the next turn's speaker to Mira.", { exact: true })).toBeVisible()
        await recent.click()
        await expect(page.getByRole("button", { name: "Generate Mira", exact: true })).toBeEnabled()
      }
    })

// Composer spacing and labels, with synthetic cast and history only.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
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
      test.setTimeout(120_000)
      const chatId = await withCookie(server(), cookie, (api) =>
        Effect.gen(function* () {
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
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      let release: (() => void) | null = null
      await page.routeWebSocket("**/rpc", (socket) => {
        const upstream = socket.connectToServer()
        socket.onMessage((message) => {
          if (release === null && String(message).includes('"tag":"Generate"')) release = () => upstream.send(message)
          else upstream.send(message)
        })
        upstream.onMessage((message) => socket.send(message))
      })
      await page.goto(`${server().url}/chats/${chatId}`)
      const generate = page.getByRole("button", {
        name: `Generate ${longName}`,
        exact: true
      })
      await expect(generate).toBeEnabled()
      const controls = page.getByTestId("composer-controls")
      const strip = page.getByRole("group", { name: "Next reply", exact: true })
      const guidance = page.getByRole("switch", { name: "Guidance", exact: true })
      const measurements: Array<{
        state: string
        on: boolean
        guidanceGenerateGap: number
        groups: Awaited<ReturnType<typeof measure>>[]
        frame: { x: number; y: number; width: number; height: number }
      }> = []
      const capture = async (state: string, primary = generate) => {
        const groups = [
          await measure(controls.locator(":scope > div").nth(0)),
          await measure(controls.locator(":scope > div").nth(1)),
          await measure(strip)
        ]
        const frame = (await page.getByTestId("composer-box").boundingBox())!
        const toggleBounds = (await guidance.boundingBox())!
        const primaryBounds = (await primary.boundingBox())!
        const guidanceGenerateGap = primaryBounds.x - toggleBounds.x - toggleBounds.width
        const on = (await guidance.getAttribute("aria-checked")) === "true"
        const primaryLabel = await primary.getAttribute("aria-label")
        measurements.push({ state, on, guidanceGenerateGap, groups, frame })
        // Check the exact pair from the owner's screenshot in every state, including a
        // highlighted or pending primary button and the disabled toggle during guidance edits.
        expect(Math.abs(guidanceGenerateGap - 6), `${state}: Guidance to primary`).toBeLessThanOrEqual(1)
        if (on) await expect(primary).toHaveClass(/bg-accent/)

        if (shots) {
          mkdirSync(shots, { recursive: true })
          const name = `${width}-${theme}-${state}`
          await controls
            .locator(":scope > div")
            .nth(1)
            .screenshot({
              path: join(shots, `${name}-actions.png`),
              animations: "disabled"
            })
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
        for (const control of groups[1]!.controls.filter((control) => control.label !== primaryLabel || width === 390))
          expect(Math.abs(control.width - 36)).toBeLessThanOrEqual(1)
        // Both groups in the box share their centre; the pickers have the same outer inset: the audit's 8 px
        // inside the 1 px border.
        expect(Math.abs(groups[0]!.controls[0]!.centre - groups[1]!.controls[0]!.centre)).toBeLessThanOrEqual(1)
        expect(Math.abs(groups[0]!.controls[0]!.x - frame.x - 9)).toBeLessThanOrEqual(1)
        const last = groups[1]!.controls.at(-1)!
        expect(Math.abs(frame.x + frame.width - last.x - last.width - 9)).toBeLessThanOrEqual(1)
        expect(Math.abs(groups[2]!.controls[0]!.x - frame.x - 9)).toBeLessThanOrEqual(1)
        expect(
          await strip.evaluate(
            (el) => parseFloat(getComputedStyle(el).paddingRight) + parseFloat(getComputedStyle(el).borderRightWidth)
          )
        ).toBe(9)
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
      }
      for (const on of [false, true]) {
        if (on) await guidance.click()
        await expect(guidance).toHaveAttribute("aria-checked", String(on))
        for (const text of ["", on ? "Let the captain discover a sheltered route." : "The pass is open."]) {
          await page.getByTestId("composer").fill(text)
          await capture(`${on ? "guidance" : "message"}-${text ? "text" : "empty"}`)
        }
        await expect(generate).toHaveText(width === 390 ? "" : "Generate")
        // Clicking dismisses the explanation until the pointer leaves the toggle.
        await page.mouse.move(0, 0)
        await guidance.hover()
        await expect(page.getByText(`Click to turn guidance ${on ? "off" : "on"}`, { exact: false })).toBeVisible()
        await guidance.focus()
        await page.keyboard.press("Tab")
        await expect(generate).toBeFocused()
        await expect(page.getByText(new RegExp(`^Generate ${longName}'s next turn`))).toBeVisible()
        await page.getByTestId("composer").focus()
      }
      await generate.click()
      await expect.poll(() => release !== null).toBe(true)
      await expect(generate).toHaveAttribute("aria-busy", "true")
      await expect(generate).toBeDisabled()
      await capture("guidance-pending")
      release!()
      await expect(generate).toBeEnabled()
      await page.getByRole("button", { name: "New version with this guidance", exact: true }).click()
      const newVersion = page.getByRole("button", { name: "New version", exact: true })
      await expect(guidance).toBeChecked()
      await expect(guidance).toBeDisabled()
      await expect(newVersion).toBeEnabled()
      await capture("guidance-editing", newVersion)
      await page.getByRole("button", { name: "Close: back to new messages", exact: true }).click()
      await expect(generate).toBeEnabled()
      if (shots)
        writeFileSync(join(shots, `${width}-${theme}-measurements.json`), JSON.stringify(measurements, null, 2))
      {
        // A second possible replier: the strip is the group's, Next with whole labels and nothing
        // beside it (owner 2026-11-17: no ▶ Reply now, the empty Send is it; Auto replies are in
        // the Cast tab).
        await withCookie(server(), cookie, (api) =>
          Effect.gen(function* () {
            const entityId = (yield* api.CreateCard({ label: `Wren ${width} ${theme}`, name: "Wren", version: "1" }))
              .entityId
            yield* api.ChangeCast({ chatId, slotId: null, change: { _tag: "Join", entityId } })
          })
        )
        await page.getByTestId("composer").fill("")
        const next = strip.getByRole("button", { name: /^Next: / })
        await expect(next).toBeEnabled()
        await expect(strip.getByRole("button", { name: /replies now$|^Reply now$|^Auto/ })).toHaveCount(0)
        await expect(page.getByRole("button", { name: /^(Mira|Wren)\b.* repl(?:y|ies)$/ })).toBeEnabled()
        const full = await measure(strip)
        for (const gap of full.gaps) expect(Math.abs(gap - 6)).toBeLessThanOrEqual(1)
        for (const control of full.controls) {
          expect(Math.abs(control.height - 36)).toBeLessThanOrEqual(1)
          expect(Math.abs(control.centre - full.controls[0]!.centre)).toBeLessThanOrEqual(1)
        }
        // Each chip shows its whole label here: none is cut to an ellipsis.
        for (const chip of await strip.getByRole("button").all())
          expect(
            await chip.evaluate((node) =>
              [...node.querySelectorAll("span")].every((s) => s.scrollWidth <= s.clientWidth)
            ),
            `${await chip.getAttribute("aria-label")}: whole label`
          ).toBe(true)
        if (shots) await strip.screenshot({ path: join(shots, `${width}-${theme}-strip.png`), animations: "disabled" })
        if (process.env.LAYOUT_AUDIT)
          await expectLayout(page, test.info(), `composer-strip-${width}-${theme}`, {
            scope: '[aria-label="Next reply"]'
          })
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

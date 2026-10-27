// The RP loop (DESIGN §2.2, §3.5): the persona separate from the speaker, the composer's
// guidance toggle, conditioned prompts in the preset editor, muting and the one-time
// impersonation notice, on the realistic synthetic ST folder through a fake provider, so the
// requests are the assembler's own. Every card, chat and preset here is made up.
import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import type { ChatId } from "@rp/shared/chat.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { writeRealisticStFolder } from "../../server/test/support/stRealistic.ts"
import { openPanel } from "./support/panel.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = resolve(process.env.SCREENSHOT_DIR ?? "p1-1-work/screenshots")
let provider: FakeProvider
let presets: ReadonlyArray<LibraryRef>
/** The Lantern Inn: a group chat with one member muted, as ST's disabled members import. */
let inn: ChatId

const usePreset = (label: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const defaults = yield* api.GetGenerationDefaults()
      yield* api.SetGenerationDefaults({
        defaults: { model: defaults.model, preset: presets.find((p) => p.label === label)!.id }
      })
    })
  )
const setGuidance = (guidance: boolean) => admin((api) => api.SetDisplayPrefs({ prefs: { guidance } }))
const newestVersion = () =>
  admin((api) =>
    Effect.map(
      api.ReadPath({ chatId: inn, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 }),
      (w) => w.entries.at(-1)!.version
    )
  )

test.setTimeout(300_000)
test.describe.configure({ mode: "serial" })
test.beforeAll(async ({ browser }) => {
  mkdirSync(shots, { recursive: true })
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const folder = writeRealisticStFolder(join(server().dataDir, "synthetic-st"))
  await page.goto(`${server().url}/import/st`)
  await page.getByLabel("Folder path").fill(folder)
  await page.getByRole("button", { name: "Look in this folder" }).click()
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect(page.getByRole("list", { name: "Imported" })).toBeVisible({ timeout: 180_000 })
  await page.close()
  provider = await startProvider()
  presets = await admin((api) => api.ListLibrary({ kind: "preset" }))
  const connection = await admin((api) =>
    api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Local model server",
        baseUrl: provider.baseUrl,
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      },
      apiKey: "sk-rp-loop-test-key-0042"
    })
  )
  await admin((api) => api.RefreshModels({ connectionId: connection.id }))
  const model = (await admin((api) => api.ListModels({ connectionId: connection.id, includeHidden: false }))).find(
    (m) => m.key === "fake-large"
  )!
  await admin((api) =>
    api.SetGenerationDefaults({
      defaults: {
        model: { connection: connection.id, model: model.id },
        preset: presets.find((p) => p.label === "Night RP 3.1")!.id
      }
    })
  )
  inn = await admin((api) =>
    Effect.gen(function* () {
      const library = yield* api.GetShellLibrary()
      for (const fork of library.forks.filter((f) => f.current && f.cast.length >= 4)) {
        const cast = yield* api.GetCast({ chatId: fork.chat.id, slotId: null })
        if (cast.absent.length > 0) return fork.chat.id
      }
      throw new Error("No group chat with a muted member")
    })
  )
})

test.afterAll(async () => {
  await provider?.stop()
})

const shoot = async (page: Page, name: string, width: number, theme: string) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  await page.screenshot({ path: join(shots, `${name}-${width}-${theme}.png`) })
}

const composerBox = (page: Page) => page.locator("#composer")
const guidanceSwitch = (page: Page) => page.getByRole("switch", { name: "Guidance", exact: true })
const lastMessage = (page: Page) => page.locator("article[data-slot]").last()

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`the RP loop at ${width}px, ${theme}`, async ({ page }) => {
      const shot = (name: string) => shoot(page, name, width, theme)
      await page.setViewportSize({ width, height: width > 500 ? 1000 : 844 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await setGuidance(false)
      await usePreset("Night RP 3.1")
      await page.goto(`${server().url}/chats/${inn}`)
      const box = composerBox(page)
      await expect(box).toBeEditable()
      await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible()
      await shot("01-composer-guidance-off")
      await box.fill("I lean on the bar and listen.")
      await shot("02-composer-off-with-text")
      await box.fill("")

      // Guidance on: its own look, label and placeholder; Send gives way to generating.
      await guidanceSwitch(page).click()
      await expect(guidanceSwitch(page)).toBeChecked()
      const guidance = page.getByRole("textbox", { name: "Guidance", exact: true })
      await expect(guidance).toHaveAttribute("placeholder", "Direction for the next message…")
      await expect(page.locator("[data-guidance]").first()).toBeVisible()
      await expect(page.getByRole("button", { name: /^Send/ })).toHaveCount(0)
      await shot("03-composer-guidance-empty")
      const direction = `Have the stranger by the fire speak up (${width} ${theme}).`
      await guidance.fill(direction)
      await shot("04-composer-guidance-text")

      // Enter generates the reply-from character's turn with the text as its direction; the text stays.
      const sent = provider.completions.length
      await guidance.press("Enter")
      await expect.poll(() => provider.completions.length).toBe(sent + 1)
      const request = provider.completions.at(-1)!.messages
      expect(request.at(-1)!.role).toBe("user")
      expect(request.at(-1)!.content).toContain(direction)
      await expect(lastMessage(page)).toContainText(`Direction: ${direction}`)
      await expectTextBox(guidance, direction)
      await shot("05-after-generate-text-stays")

      // A swipe with guidance on carries the text.
      await page.getByRole("button", { name: "Regenerate the latest reply", exact: true }).click()
      await expect.poll(() => provider.completions.length).toBe(sent + 2)
      await expect.poll(async () => (await newestVersion()).direction).toBe(direction)
      await expect(lastMessage(page)).toContainText(`Direction: ${direction}`)
      await shot("06-swipe-with-direction")
      const directed = (await newestVersion()).id

      // The toggle is the account's: it's still on after a reload.
      await page.reload()
      await expect(guidanceSwitch(page)).toBeChecked()
      await expectTextBox(composerBox(page), direction)

      // Off: a swipe takes nothing from the box, and reuses nothing.
      await guidanceSwitch(page).click()
      await expect(guidanceSwitch(page)).not.toBeChecked()
      await page.getByRole("button", { name: "Regenerate the latest reply", exact: true }).click()
      await expect.poll(() => provider.completions.length).toBe(sent + 3)
      await expect.poll(async () => (await newestVersion()).direction).toBeNull()
      expect(
        provider.completions
          .at(-1)!
          .messages.map((m) => m.content)
          .join("\n")
      ).not.toContain(direction)
      await expectTextBox(composerBox(page), direction)
      await composerBox(page).fill("")

      // The request inspector for the directed reply: the direction prompt, and who it was for.
      await page.goto(`${server().url}/chats/${inn}/context/${directed}`)
      await expect(page.getByText(direction).first()).toBeVisible()
      await shot("07-inspector-directed")
      await page.goto(`${server().url}/chats/${inn}`)
      await expect(composerBox(page)).toBeEditable()

      // The persona control opens on Personas; picking a speaker doesn't change the persona.
      const cast = await openPanel(page, "Cast")
      const you = cast.getByRole("group", { name: "Your persona" })
      const persona = you.getByRole("button", { name: /^Playing as / })
      const personaLabel = await persona.getAttribute("aria-label")
      await persona.click()
      await expect(page.getByRole("tab", { name: "Personas", selected: true })).toBeVisible()
      await shot("08-persona-control")
      await page.keyboard.press("Escape")
      await expect(cast.getByText("muted", { exact: true }).first()).toBeVisible()
      await expect(cast.getByRole("heading", { level: 2 })).toContainText("1 muted")
      const mutedRow = cast.getByRole("listitem").filter({ hasText: "muted" }).first()
      const mutedName = (await mutedRow.getAttribute("aria-label"))!
      await expect(mutedRow.getByRole("switch")).toBeChecked()
      await shot("09-cast-tab-muted")
      // Never picked automatically: it's not offered to reply.
      await expect(page.getByRole("group", { name: "Reply from" })).not.toContainText(mutedName)
      await page.getByRole("button", { name: /^Speaking as / }).click()
      await page.getByRole("tab", { name: "Members", exact: true }).click()
      await page.getByRole("option", { name: mutedName, exact: true }).click()
      await expect(page.getByRole("button", { name: `Speaking as ${mutedName}. Change the speaker` })).toBeVisible()
      await expect(you.getByRole("button", { name: /^Playing as / })).toHaveAttribute("aria-label", personaLabel!)

      // Writing for the persona: an impersonation, with the preset's impersonation prompt.
      await page.getByRole("button", { name: /^Speaking as / }).click()
      await page.getByRole("tab", { name: "Personas", exact: true }).click()
      const personaName = personaLabel!.replace(/^Playing as /, "").replace(/\. Change your persona$/, "")
      await page.getByRole("option", { name: personaName, exact: true }).click()
      const impersonated = provider.completions.length
      await page.getByRole("button", { name: `Write for ${personaName}`, exact: true }).click()
      await expect.poll(() => provider.completions.length).toBe(impersonated + 1)
      expect(
        provider.completions
          .at(-1)!
          .messages.map((m) => m.content)
          .join("\n")
      ).toContain(`[Write ${personaName}'s next reply in their voice`)
      await expect.poll(async () => (await newestVersion()).status).toBe("complete")
      // Night RP 3.1 has its impersonation prompt: no notice.
      await expect(page.getByText(/may need “not when writing as/)).toHaveCount(0)
      await page.goto(`${server().url}/chats/${inn}/context/${(await newestVersion()).id}`)
      await expect(page.getByText("sent when writing as {{user}}").first()).toBeVisible()
      await shot("10-inspector-impersonation")

      // The preset editor: conditions, the import's prompt, and both warnings.
      await page.goto(`${server().url}/library`)
      await page.getByRole("button", { name: "Edit Night RP 3.1", exact: true }).click()
      const editor = page.getByRole("dialog", { name: "Preset editor", exact: true })
      await expect(editor).toBeVisible()
      const direct = editor.locator('[data-prompt="direction"]')
      await expect(direct).toContainText("added on import")
      await expect(direct).toContainText("with a direction")
      await expect(direct.getByRole("button", { name: "Delete the prompt" })).toHaveCount(0)
      const style = editor.locator('[data-prompt="night-impersonation-style"]')
      await expect(style).toContainText("as {{user}}")
      await expect(style.getByRole("combobox", { name: "Condition" })).toContainText("When writing as {{user}}")
      await shot("11-editor-conditions")
      await direct.getByRole("switch").click()
      const nudge = editor.locator('[data-prompt="groupNudge"]')
      await nudge.getByRole("combobox", { name: "Role" }).click()
      await page.getByRole("option", { name: "assistant", exact: true }).click()
      const warnings = editor.getByRole("group", { name: "Preset warnings" })
      await expect(warnings).toContainText("end on an assistant prompt, “Group nudge”")
      await expect(warnings).toContainText("No prompt that's on sends the direction")
      await editor.getByTestId("preset-scroll").evaluate((e) => (e.scrollTop = 0))
      await shot("12-editor-warnings")
      await warnings.getByRole("button", { name: "Go to the prompt" }).click()
      await expect(nudge).toBeInViewport()
      // Put both back as they were (the drafts are this account's).
      await nudge.getByRole("combobox", { name: "Role" }).click()
      await page.getByRole("option", { name: "system", exact: true }).click()
      await direct.getByRole("switch").click()
      await expect(warnings).toHaveCount(0)
      await editor.getByRole("button", { name: "Close preset editor", exact: true }).click()

      // The one-time notice, with a preset whose impersonation prompt is off.
      if (theme === "light") {
        const label = width > 500 ? "Celia 4.2" : "Pixijb v18"
        await usePreset(label)
        await page.goto(`${server().url}/library`)
        await page.getByRole("button", { name: `Edit ${label}`, exact: true }).click()
        await editor.locator('[data-prompt="impersonationPrompt"]').getByRole("switch").click()
        await editor.getByRole("button", { name: /^Save \(/ }).click()
        await page
          .getByRole("dialog", { name: "Save a revision" })
          .getByRole("button", { name: "Save revision" })
          .click()
        await editor.getByRole("button", { name: "Close preset editor", exact: true }).click()
        await page.goto(`${server().url}/chats/${inn}`)
        const write = page.getByRole("button", { name: `Write for ${personaName}`, exact: true })
        await write.click()
        const notice = page.getByRole("status").filter({ hasText: "may need “not when writing as" })
        await expect(notice).toBeVisible()
        await shot("13-impersonation-notice")
        await notice.getByRole("button", { name: "Dismiss" }).click()
        await expect.poll(async () => (await newestVersion()).status).toBe("complete")
        await write.click()
        await expect.poll(async () => (await newestVersion()).status).toBe("complete")
        await expect(notice).toHaveCount(0)
        await usePreset("Night RP 3.1")
      }
    })

test("guidance on a touch screen: Ctrl+Enter generates, Enter is a new line", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await setGuidance(true)
  await page.goto(`${server().url}/chats/${inn}`)
  const guidance = page.getByRole("textbox", { name: "Guidance", exact: true })
  await expect(guidance).toBeEditable()
  await guidance.fill("The rain stops.")
  await guidance.press("Enter")
  await expectTextBox(guidance, "The rain stops.\n")
  const sent = provider.completions.length
  await guidance.press("Control+Enter")
  await expect.poll(() => provider.completions.length).toBe(sent + 1)
  await expect.poll(async () => (await newestVersion()).direction).toBe("The rain stops.\n")
  await expectTextBox(guidance, "The rain stops.\n")
  await setGuidance(false)
  await context.close()
})

test("the pending chat's Playing as is the persona control, and guidance generates the first reply", async ({
  page
}) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await setGuidance(true)
  await page.goto(`${server().url}/library`)
  await page
    .getByRole("link", { name: /^Start a chat with / })
    .first()
    .click()
  await page.getByRole("button", { name: /^Playing as / }).click()
  await expect(page.getByRole("tab", { name: "Personas", selected: true })).toBeVisible()
  await page.keyboard.press("Escape")
  const guidance = page.getByRole("textbox", { name: "Guidance", exact: true })
  await guidance.fill("Open on the docks at dawn.")
  const sent = provider.completions.length
  await guidance.press("Enter")
  await expect(page).toHaveURL(/\/chats\/[^/?]+$/)
  await expect.poll(() => provider.completions.length).toBe(sent + 1)
  expect(provider.completions.at(-1)!.messages.at(-1)!.content).toContain("Open on the docks at dawn.")
  await expectTextBox(page.getByRole("textbox", { name: "Guidance", exact: true }), "Open on the docks at dawn.")
  await setGuidance(false)
})

import { setGuidance as setComposerGuidance } from "./support/composer.ts"
// The RP loop (DESIGN §2.2, §3.5): the persona separate from the speaker, the composer's
// guidance toggle, conditioned prompts in the preset editor and muting, on the realistic
// synthetic ST folder through a fake provider, so the requests are the assembler's own. Every card, chat and preset here is made up.
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import type { LibraryRef } from "@dreamspan/shared/library.ts"
import { Effect } from "effect"
import { writeRealisticStFolder } from "../../server/test/support/stRealistic.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { unsentEditorCopies } from "./support/editorCopies.ts"
import { choices, nextChip, nextName, pickReply } from "./support/strip.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
// One session for the whole file: logging in for every call runs into the login rate limit.
let cookie: string | null = null
const admin = async <A>(use: Parameters<typeof withCookie<A>>[2]) =>
  withCookie(server(), (cookie ??= await loginCookie(server(), ADMIN.handle, ADMIN.password)), use)
const shots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-loop-screenshots"))
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
const setGuidance = (guidance: boolean) => admin((api) => setComposerGuidance(api, inn, guidance))
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

const composerBox = (page: Page) => page.getByTestId("composer")
const guidanceSwitch = (page: Page) => page.getByRole("switch", { name: "Guidance", exact: true })
const lastMessage = (page: Page) => page.locator("article[data-slot]").last()
/** The latest reply's › past its last version, shown without a hover at every width. */
const regenerateLatest = (page: Page) =>
  lastMessage(page)
    .getByRole("group", { name: "Swipes" })
    .getByRole("button", { name: "Generate another swipe" })
    .click()
/** The inspector's list draws rows as they scroll in: its end, where the tail is. */
const inspectorEnd = async (page: Page, text: string) => {
  await expect
    .poll(async () => {
      await page.evaluate(() => {
        for (const element of [document.scrollingElement, ...document.querySelectorAll("main, main *")])
          if (element && element.scrollHeight > element.clientHeight) element.scrollTop = element.scrollHeight
      })
      return page.getByText(text).count()
    })
    .toBeGreaterThan(0)
  await page.getByText(text).last().scrollIntoViewIfNeeded()
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`the RP loop at ${width}px, ${theme}`, async ({ page }) => {
      const shot = (name: string) => shoot(page, name, width, theme)
      await page.setViewportSize({ width, height: width > 500 ? 1000 : 844 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
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

      // Guidance on: its own look, label and placeholder; Send stays beside Generate. With nothing
      // typed it asks for the reply alone (owner, 2026-11-17: no Reply now), so whether it's
      // enabled depends on who can reply, not on the guidance mode.
      await guidanceSwitch(page).click()
      await expect(guidanceSwitch(page)).toBeChecked()
      const guidance = page.getByRole("textbox", { name: "Guidance", exact: true })
      await expect(guidance).toHaveAttribute("placeholder", "Guidance for the next message…")
      await expect(page.locator("[data-guidance]").first()).toBeVisible()
      await expect(
        page.getByTestId("composer-controls").getByRole("button", { name: /^(?:Send|.* repl(?:y|ies)$)/ })
      ).toBeVisible()
      await shot("03-composer-guidance-empty")
      const direction = `Have the stranger by the fire speak up (${width} ${theme}).`
      await guidance.fill(direction)
      await shot("04-composer-guidance-text")

      // Enter generates the selected speaker's turn (the persona's here, not the reply-from
      // character's) with the text as its direction, under the primary Generate; the text
      // leaves the box, and the reply shows it.
      const chip = await page.getByRole("button", { name: /^Speaking as / }).getAttribute("aria-label")
      const speaker = chip!.replace(/^Speaking as /, "").replace(/\. Change the speaker$/, "")
      await expect(page.getByRole("button", { name: `Generate ${speaker}` })).toHaveClass(/bg-accent/)
      const sent = provider.completions.length
      await guidance.press("Enter")
      await expect.poll(() => provider.completions.length).toBe(sent + 1)
      const request = provider.completions.at(-1)!.messages
      expect(request.at(-1)!.role).toBe("user")
      expect(request.at(-1)!.content).toContain(direction)
      await expect(lastMessage(page)).toContainText(`Guidance: ${direction}`)
      await expect(lastMessage(page).locator("header").first()).toContainText(speaker)
      await expectTextBox(guidance, "")
      await shot("05-after-generate-box-cleared")

      // A swipe reuses the guidance of the version it re-rolls, not the box's text.
      await guidance.fill("My own next line, not guidance for this reply.")
      await regenerateLatest(page)
      await expect.poll(() => provider.completions.length).toBe(sent + 2)
      await expect.poll(async () => (await newestVersion()).direction).toBe(direction)
      await expect(lastMessage(page)).toContainText(`Guidance: ${direction}`)
      await shot("06-swipe-with-direction")
      const directed = (await newestVersion()).id

      // The toggle is the account's: it's still on after a reload.
      await page.reload()
      await expect(guidanceSwitch(page)).toBeChecked()
      await expectTextBox(composerBox(page), "My own next line, not guidance for this reply.")

      // Off: a swipe still reuses the re-rolled version's guidance, and takes nothing from the box.
      await guidanceSwitch(page).click()
      await expect(guidanceSwitch(page)).not.toBeChecked()
      await regenerateLatest(page)
      await expect.poll(() => provider.completions.length).toBe(sent + 3)
      await expect.poll(async () => (await newestVersion()).direction).toBe(direction)
      const swiped = provider.completions
        .at(-1)!
        .messages.map((m) => m.content)
        .join("\n")
      expect(swiped).toContain(direction)
      expect(swiped).not.toContain("My own next line")
      await expectTextBox(composerBox(page), "My own next line, not guidance for this reply.")
      await composerBox(page).fill("")

      // The request inspector for the directed reply: the direction prompt, and who it was for.
      await page.goto(`${server().url}/chats/${inn}/context/${directed}`)
      await inspectorEnd(page, direction)
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
      await expect(cast.getByText("Muted", { exact: true }).first()).toBeVisible()
      await expect(cast.getByRole("heading", { level: 2, name: /muted/ })).toContainText("1 muted")
      const mutedRow = cast
        .getByRole("list", { name: "Characters in this chat" })
        .getByRole("listitem")
        .filter({ has: page.getByText("Muted", { exact: true }) })
        .first()
      const mutedName = (await mutedRow.getAttribute("aria-label"))!
      // The synthetic import's standard version is part of every Next choice.
      const mutedChoice = `${mutedName} · 1`
      await expect(mutedRow.getByRole("button", { name: `Unmute ${mutedName}`, exact: true })).toBeVisible()
      await shot("09-cast-tab-muted")
      // Never picked automatically: it's not offered to reply.
      if (width < 1024) await closePanel(page)
      await expect(nextChip(page)).toBeVisible()
      await expect(nextChip(page)).not.toHaveAccessibleName(nextName(mutedChoice))
      const whoReplies = choices(page, "Who replies next")
      await nextChip(page).click()
      await expect(whoReplies.getByRole("radio", { name: /^Auto: .+$/ })).toBeChecked()
      await expect(whoReplies.getByRole("radio", { name: /^Auto: / })).not.toHaveAccessibleName(`Auto: ${mutedChoice}`)
      // It can still be picked for one reply, explicitly.
      const muted = whoReplies.getByRole("radio", { name: mutedChoice, exact: true })
      await expect(muted).toHaveAttribute("aria-description", "Muted: replies only when picked")
      await muted.click()
      await expect(nextChip(page)).toHaveAccessibleName(nextName(mutedChoice))
      // Auto goes back to its own pick.
      await pickReply(page, null)
      await expect(nextChip(page)).not.toHaveAccessibleName(nextName(mutedChoice))
      // Writing as a member (the muted one, explicitly) doesn't change who {{user}} is.
      await page.getByRole("button", { name: /^Speaking as / }).click()
      await page.getByRole("group", { name: "Speak as" }).getByRole("option", { name: mutedName, exact: true }).click()
      await expect(page.getByRole("button", { name: `Speaking as ${mutedName}. Change the speaker` })).toBeVisible()
      const castAgain = await openPanel(page, "Cast")
      await expect(
        castAgain.getByRole("group", { name: "Your persona" }).getByRole("button", { name: /^Playing as / })
      ).toHaveAttribute("aria-label", personaLabel!)
      if (width < 1024) await closePanel(page)

      // Writing for the persona: an impersonation, with the preset's impersonation prompt.
      await page.getByRole("button", { name: /^Speaking as / }).click()
      const personaName = personaLabel!.replace(/^Playing as /, "").replace(/\. Change your persona$/, "")
      // In "Speak as": the popover's "Your persona" section lists them too, to play another persona.
      await page
        .getByRole("group", { name: "Speak as" })
        .getByRole("option", { name: personaName, exact: true })
        .click()
      const impersonated = provider.completions.length
      await page.getByRole("button", { name: `Generate ${personaName}`, exact: true }).click()
      await expect.poll(() => provider.completions.length).toBe(impersonated + 1)
      expect(
        provider.completions
          .at(-1)!
          .messages.map((m) => m.content)
          .join("\n")
      ).toContain(`[Write ${personaName}'s next reply in their voice`)
      await expect.poll(async () => (await newestVersion()).status).toBe("complete")
      await page.goto(`${server().url}/chats/${inn}/context/${(await newestVersion()).id}`)
      await inspectorEnd(page, "End of request: when your card speaks")
      await shot("10-inspector-impersonation")

      // The preset editor: conditions, the end-of-request texts, and the direction warning.
      await page.goto(`${server().url}/library`)
      await page.getByRole("tab", { name: /^Presets/ }).click()
      await page.getByRole("link", { name: "Edit Night RP 3.1", exact: true }).click()
      await expect(page).toHaveURL(/\/library\/[^/]+$/)
      const editor = page.getByRole("main")
      await expect(editor.getByRole("heading", { name: "Night RP 3.1", level: 1 })).toBeVisible()
      // The end-of-request texts are outside the order: no prompt blocks, a fixed section.
      await expect(editor.locator('[data-prompt="groupNudge"]')).toHaveCount(0)
      const end = editor.getByRole("heading", { name: "End of request" })
      await expect(end).toBeVisible()
      const direct = editor.locator('[data-end-of-request="directionPrompt"]')
      await expect(direct).toContainText("When you give guidance")
      const style = editor.locator('[data-prompt="night-impersonation-style"]')
      // ST's triggers stay a per-prompt option of their own beside the condition (owner 2026-10-28).
      await expect(style).toContainText("impersonate")
      // The options fold under the block's header (owner, 2026-11-01).
      await style.getByRole("button", { name: /^Options of / }).click()
      await expect(style.getByRole("combobox", { name: "Condition" })).toContainText("Always")
      const types = style.getByRole("group", { name: "Generation types" })
      await expect(types.getByRole("checkbox", { name: "Impersonate" })).toBeChecked()
      await expect(types.getByRole("checkbox", { name: "Normal" })).not.toBeChecked()
      await style.scrollIntoViewIfNeeded()
      await shot("11-editor-conditions")
      await end.scrollIntoViewIfNeeded()
      await shot("11a-editor-end-of-request")
      const directionText = direct.getByRole("textbox", { name: /^When you give guidance/ })
      const original = await directionText.textContent()
      await directionText.fill("[What happens next.]")
      const warnings = editor.getByRole("group", { name: "Preset warnings" })
      await expect(warnings).toContainText("doesn't contain {{direction}}")
      await page.evaluate(() => scrollTo(0, 0))
      await shot("12-editor-warnings")
      await warnings.getByRole("button", { name: "Go to the text" }).click()
      await expect(direct).toBeInViewport()
      const toolbarBottom = await editor.getByRole("button", { name: "History", exact: true }).evaluate((element) => {
        let at: HTMLElement | null = element as HTMLElement
        while (at && getComputedStyle(at).position !== "sticky") at = at.parentElement
        return at!.getBoundingClientRect().bottom
      })
      await expect
        .poll(() => directionText.evaluate((element) => element.getBoundingClientRect().top))
        .toBeGreaterThanOrEqual(toolbarBottom)
      await shot("12a-editor-direction-jump")
      // Put it back as it was (the drafts are this account's).
      await directionText.fill(original ?? "")
      await expect(warnings).toHaveCount(0)
      // A condition its generation types never meet: never sent here, and named in the warnings (inv A2).
      const condition = style.getByRole("combobox", { name: "Condition" })
      await condition.click()
      await page.getByRole("option", { name: "When writing as a character" }).click()
      const never = warnings.getByRole("alert").filter({ hasText: "is never sent" })
      await expect(never).toContainText("only for Impersonate")
      await page.evaluate(() => scrollTo(0, 0))
      await shot("12b-editor-gates-never-meet")
      await never.getByRole("button", { name: "Go to the prompt" }).click()
      await expect(style).toBeInViewport()
      await condition.click()
      await page.getByRole("option", { name: "Always" }).click()
      await expect(warnings).toHaveCount(0)
      // Back as it was, and the server has it: the next test opens this preset in a fresh browser.
      await expect.poll(() => unsentEditorCopies(page)).toBe(0)
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
  await expectTextBox(guidance, "")
  await setGuidance(false)
  await context.close()
})

test("the pending chat's Playing as is the persona control, and guidance generates the first reply", async ({
  page
}) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library`)
  await page
    .getByRole("link", { name: /^Start a chat with / })
    .first()
    .click()
  // Who you play is the Cast tab's, as in a saved chat.
  await openPanel(page, "Cast")
  await page.getByRole("button", { name: /^Playing as / }).click()
  await expect(page.getByRole("tab", { name: "Personas", selected: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await closePanel(page)
  await guidanceSwitch(page).click()
  const guidance = page.getByRole("textbox", { name: "Guidance", exact: true })
  await guidance.fill("Open on the docks at dawn.")
  const sent = provider.completions.length
  await guidance.press("Enter")
  await expect(page).toHaveURL(/\/chats\/[^/?]+(?:\?.*)?$/)
  await expect.poll(() => provider.completions.length).toBe(sent + 1)
  expect(provider.completions.at(-1)!.messages.at(-1)!.content).toContain("Open on the docks at dawn.")
  // Submitted guidance leaves the box; the chat's composer starts empty.
  await expectTextBox(page.getByRole("textbox", { name: "Guidance", exact: true }), "")
  await setGuidance(false)
})

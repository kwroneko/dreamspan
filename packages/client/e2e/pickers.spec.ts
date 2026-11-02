// The preset and model pickers (the owner, 2026-11-01): the side panel's Prompt preset and Model
// tabs open with the composer's own pickers; the preset picker filters and sorts by name, last
// modified and last used, archives from the list without closing it, and has an Archived view
// sorted by archive time; the preset in use stays shown though archived; New preset starts from
// the built-in default, chosen and opened; the library hides archived presets too; the model
// picker sorts by name or last use and links to Settings → Connections. Synthetic presets, cards
// and a fake provider only.
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { LibraryRef } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { openPanel } from "./support/panel.ts"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { modelChip, modelName, presetChip, presetName } from "./support/strip.ts"

const server = serverPerFile(withAdmin)
const shots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-picker-screenshots"))
mkdirSync(shots, { recursive: true })
let provider: FakeProvider
let cookie: string
let chatId: string
const rpc = <A>(run: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, run)

const LIVE = ["Harbor house style", "Clockwork noir", "Quiet tavern", "Ember court"]
const ARCHIVED = ["Old drafts", "Velvet rope"]
const CURRENT = "Clockwork noir"

const presets = () =>
  rpc((api) =>
    Effect.map(
      Effect.all([api.ListLibrary({ kind: "preset" }), api.ListLibrary({ kind: "preset", archived: true })]),
      ([live, archived]) => [...live, ...archived]
    )
  )
const byLabel = (all: ReadonlyArray<LibraryRef>, label: string) => all.find((ref) => ref.label === label)!

test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  provider = await startProvider()
  chatId = await rpc((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic pickers",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-picker-test-0042"
      })
      yield* api.RefreshModels({ connectionId: connection.id })
      const models = yield* api.ListModels({ connectionId: connection.id, includeHidden: false })
      // One after another, so their times differ: the last made is the last modified, until a rename.
      const made: Array<LibraryRef> = []
      for (const label of [...LIVE, ...ARCHIVED]) {
        made.push(yield* api.CreatePreset({ label }))
        yield* Effect.sleep(15)
      }
      const quiet = made.find((ref) => ref.label === "Quiet tavern")!
      yield* api.RenameRef({
        refId: quiet.id,
        label: "Quiet tavern",
        subtitle: "",
        expectedRowVersion: quiet.rowVersion
      })
      const current = made.find((ref) => ref.label === CURRENT)!
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: models[0]!.id }, preset: current.id }
      })
      const card = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      const started = yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "The lanterns are lit.", speakerEntityId: null }
      })
      // A reply with the current preset and model: their Last used.
      yield* api.Generate({ chatId: started.chat.id, parentSlotId: started.entry.slotId, branch: false })
      return started.chat.id
    })
  )
  await expect.poll(async () => byLabel(await presets(), CURRENT).lastUsedAt ?? null).not.toBeNull()
})
test.afterAll(async () => {
  await provider?.stop()
})

/** Every test starts from the same choices: the current preset and model, two archived, Old drafts first. */
const reset = () =>
  rpc((api) =>
    Effect.gen(function* () {
      const all = [
        ...(yield* api.ListLibrary({ kind: "preset" })),
        ...(yield* api.ListLibrary({ kind: "preset", archived: true }))
      ]
      for (const ref of all) if (ref.archivedAt != null) yield* api.SetRefArchived({ refId: ref.id, archived: false })
      for (const label of ARCHIVED) {
        yield* api.SetRefArchived({ refId: byLabel(all, label).id, archived: true })
        yield* Effect.sleep(15)
      }
      yield* api.ChangeGenerationDefaults({ change: { preset: byLabel(all, CURRENT).id } })
      yield* api.SetDisplayPrefs({ prefs: { presetSort: "name", modelSort: "name" } })
    })
  )

const KNOWN = new Set(["Default (built-in)", ...LIVE, ...ARCHIVED])
/** The rows' names in order, the ones this file made (a New preset test adds others). */
const rows = async (list: Locator) =>
  (await list.getByRole("radio").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""))).filter(
    (name) => KNOWN.has(name)
  )
const pickerList = (page: Page) => page.getByRole("radiogroup", { name: "Prompt preset", exact: true })
const view = (page: Page, name: RegExp | string) =>
  page.getByRole("group", { name: "Show presets", exact: true }).getByRole("button", { name })

const openChat = async (page: Page, width: number, theme: "light" | "dark" = "light") => {
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
}
const tabPicker = (panel: Locator) => panel.getByRole("button", { name: /^Prompt preset for the next reply: / })

for (const width of [1440, 390]) {
  test(`the Prompt preset tab opens with the composer's picker, and choosing there is choosing in the composer (${width}px)`, async ({
    page
  }) => {
    await reset()
    await openChat(page, width)
    await expect(presetChip(page)).toHaveAccessibleName(presetName(CURRENT))
    const panel = await openPanel(page, "Prompt preset")
    // At the very top, the current preset selected.
    await expect(tabPicker(panel)).toHaveAccessibleName(`Prompt preset for the next reply: ${CURRENT}. Change it`)
    await tabPicker(panel).click()
    await expect(pickerList(page).getByRole("radio", { name: CURRENT, exact: true })).toBeChecked()
    await pickerList(page).getByRole("radio", { name: "Ember court", exact: true }).click()
    await expect(pickerList(page)).toHaveCount(0)
    await expect(tabPicker(panel)).toHaveAccessibleName("Prompt preset for the next reply: Ember court. Change it")
    // The same server call as the chip: the account's preset, which the chip shows.
    await expect
      .poll(async () => (await rpc((api) => api.GetGenerationDefaults())).preset)
      .toBe(byLabel(await presets(), "Ember court").id)
    if (width === 390) await page.getByRole("button", { name: "Close", exact: true }).click()
    await expect(presetChip(page)).toHaveAccessibleName(presetName("Ember court"))
    // And the chip's popover is the same picker, with Ember court selected.
    await presetChip(page).click()
    await expect(pickerList(page).getByRole("radio", { name: "Ember court", exact: true })).toBeChecked()
    await expect(page.getByRole("group", { name: "Show presets", exact: true })).toBeVisible()
  })

  test(`the preset picker filters, sorts by name, modified and used, and archives from the list (${width}px)`, async ({
    page
  }) => {
    await reset()
    for (const theme of ["light", "dark"] as const) {
      await openChat(page, width, theme)
      await presetChip(page).click()
      const list = pickerList(page)
      // It opens on the sort chosen last: Name the first time, Used (below) the second.
      await expect(view(page, theme === "light" ? "Name" : "Used")).toHaveAttribute("aria-pressed", "true")
      await view(page, "Name").click()
      // Each preset's last modified under its name, muted; the exact time in its tooltip.
      await expect(list.getByRole("radio", { name: "Quiet tavern", exact: true })).toHaveAccessibleDescription(
        /^edited (just now|\d+ minutes? ago)$/
      )
      expect(await rows(list)).toEqual([
        "Default (built-in)",
        "Clockwork noir",
        "Ember court",
        "Harbor house style",
        "Quiet tavern"
      ])
      await page.screenshot({ path: join(shots, `picker-name-${width}-${theme}.png`) })
      await view(page, "Modified").click()
      // The rename made Quiet tavern the last modified; the rest by when they were made.
      expect(await rows(list)).toEqual([
        "Default (built-in)",
        "Quiet tavern",
        "Ember court",
        "Clockwork noir",
        "Harbor house style"
      ])
      await page.screenshot({ path: join(shots, `picker-modified-${width}-${theme}.png`) })
      await view(page, "Used").click()
      expect(await rows(list)).toEqual([
        "Default (built-in)",
        "Clockwork noir",
        "Ember court",
        "Harbor house style",
        "Quiet tavern"
      ])
      await expect(list.getByRole("radio", { name: "Ember court", exact: true })).toHaveAccessibleDescription(
        /^never used · edited /
      )
      await page.screenshot({ path: join(shots, `picker-used-${width}-${theme}.png`) })
      // Still filtered by the text, in this view.
      await page.getByRole("searchbox", { name: "Find a prompt preset" }).fill("OU")
      expect(await rows(list)).toEqual(["Ember court", "Harbor house style"])
      await page.getByRole("searchbox", { name: "Find a prompt preset" }).fill("")
      await view(page, /^Archived/).click()
      // Only archived ones, the most recently archived first.
      expect(await rows(list)).toEqual(["Velvet rope", "Old drafts"])
      await expect(list.getByRole("radio", { name: "Velvet rope", exact: true })).toHaveAccessibleDescription(
        /^archived (just now|\d+ minutes? ago) · edited /
      )
      await page.screenshot({ path: join(shots, `picker-archived-${width}-${theme}.png`) })
      await page.keyboard.press("Escape")
      await expect(list).toHaveCount(0)
    }
    // The sort is remembered for the account; Archived isn't (the list reopens on the last sort).
    await expect.poll(async () => (await rpc((api) => api.GetDisplayPrefs({}))).presetSort).toBe("used")

    await presetChip(page).click()
    const list = pickerList(page)
    await view(page, "Name").click()
    // Archive from the list: the row goes, the list stays open, nothing is chosen.
    await list.getByRole("button", { name: "Archive Harbor house style", exact: true }).hover()
    await expect(page.getByText("Archive: hide it from these lists; nothing is deleted")).toBeVisible()
    await list.getByRole("button", { name: "Archive Harbor house style", exact: true }).click()
    await expect(list.getByRole("radio", { name: "Harbor house style", exact: true })).toHaveCount(0)
    await expect(list).toBeVisible()
    await expect(list.getByRole("radio", { name: CURRENT, exact: true })).toBeChecked()
    await expect(page.getByRole("status").filter({ hasText: "Archived “Harbor house style”" })).toBeVisible()
    await view(page, /^Archived/).click()
    expect(await rows(list)).toEqual(["Harbor house style", "Velvet rope", "Old drafts"])
    // Unarchive, from the same place.
    await list.getByRole("button", { name: "Unarchive Old drafts", exact: true }).click()
    await expect(list.getByRole("radio", { name: "Old drafts", exact: true })).toHaveCount(0)
    await view(page, "Name").click()
    expect(await rows(list)).toEqual([
      "Default (built-in)",
      "Clockwork noir",
      "Ember court",
      "Old drafts",
      "Quiet tavern"
    ])
    // The preset in use can be archived: it stays in use, shown at the top, marked archived.
    await list.getByRole("button", { name: `Archive ${CURRENT}`, exact: true }).click()
    await expect(list.getByRole("radio", { name: CURRENT, exact: true })).toBeChecked()
    expect((await rows(list))[0]).toBe(CURRENT)
    await expect(list.locator(`[data-picker-row]`).first().getByText("Archived", { exact: true })).toBeVisible()
    await page.screenshot({ path: join(shots, `picker-archived-current-${width}.png`) })
    await page.keyboard.press("Escape")
    await expect(presetChip(page)).toHaveAccessibleName(presetName(CURRENT))
    expect((await rpc((api) => api.GetGenerationDefaults())).preset).toBe(byLabel(await presets(), CURRENT).id)
  })

  test(`New preset in the Prompt preset tab starts from the built-in default, chosen and opened (${width}px)`, async ({
    page
  }) => {
    await reset()
    await openChat(page, width)
    const panel = await openPanel(page, "Prompt preset")
    await panel.getByRole("button", { name: "New preset", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "New prompt preset" })
    await expect(dialog.getByText(/Start with the built-in preset/)).toBeVisible()
    const name = `Lantern hall ${width}`
    await dialog.getByLabel("Name").fill(name)
    await page.screenshot({ path: join(shots, `new-preset-${width}.png`) })
    await dialog.getByRole("button", { name: "Create", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Preset editor", exact: true })).toBeVisible()
    await expect
      .poll(async () => (await rpc((api) => api.GetGenerationDefaults())).preset)
      .toBe(byLabel(await presets(), name).id)
    await page.getByRole("button", { name: "Close preset editor" }).click()
    await expect(presetChip(page)).toHaveAccessibleName(presetName(name))
    // The picker's list has it too, at its end.
    await presetChip(page).click()
    await expect(page.getByRole("button", { name: "New preset…", exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
  })

  test(`the library hides archived presets and has the same Archived view (${width}px)`, async ({ page }) => {
    await reset()
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/library`)
    await page.getByRole("tab", { name: /^Presets/ }).click()
    const list = page.getByRole("list", { name: "Presets", exact: true })
    await expect(list.getByRole("link", { name: "Clockwork noir", exact: true })).toBeVisible()
    await expect(list.getByRole("link", { name: "Velvet rope", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "New prompt preset", exact: true })).toBeVisible()
    await list.getByRole("button", { name: "Archive Quiet tavern", exact: true }).click()
    await expect(list.getByRole("link", { name: "Quiet tavern", exact: true })).toHaveCount(0)
    await view(page, /^Archived/).click()
    const archived = page.getByRole("list", { name: "Presets", exact: true })
    // The names, most recently archived first (each row also links Edit).
    await expect(archived.getByRole("link", { name: /^(Quiet tavern|Velvet rope|Old drafts)$/ })).toHaveText([
      "Quiet tavern",
      "Velvet rope",
      "Old drafts"
    ])
    await page.screenshot({ path: join(shots, `library-archived-${width}.png`) })
    await archived.getByRole("button", { name: "Unarchive Quiet tavern", exact: true }).click()
    await expect(archived.getByRole("link", { name: "Quiet tavern", exact: true })).toHaveCount(0)
  })

  test(`the Model tab opens with the composer's model picker, sorted by name or use, linked to connections (${width}px)`, async ({
    page
  }) => {
    await reset()
    for (const theme of ["light", "dark"] as const) {
      await openChat(page, width, theme)
      const before = await modelChip(page).getAttribute("aria-label")
      const panel = await openPanel(page, "Model")
      const trigger = panel.getByRole("button", { name: /^Model for the next reply: / })
      await expect(trigger).toHaveAccessibleName(
        `${before!.replace(/^Model: /, "Model for the next reply: ").replace(/\. Change the model$/, ". Change it")}`
      )
      await trigger.click()
      const list = page.getByRole("radiogroup", { name: "Model", exact: true })
      const names = await list.getByRole("radio").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))
      expect(names).toHaveLength(2)
      // fake-large wrote the reply made before; fake-small never has.
      await expect(list.getByRole("radio", { name: /fake-large$/ })).toHaveAccessibleDescription(/^used /)
      await expect(list.getByRole("radio", { name: /fake-small$/ })).toHaveAccessibleDescription("never used")
      await page.getByRole("group", { name: "Sort models" }).getByRole("button", { name: "Used" }).click()
      await expect(list.getByRole("radio").first()).toHaveAccessibleName(/fake-large$/)
      await expect(page.getByRole("link", { name: "Manage connections…" })).toBeVisible()
      await page.screenshot({ path: join(shots, `model-picker-${width}-${theme}.png`) })
      const other = names.find((name) => !before!.includes(name!))!
      await list.getByRole("radio", { name: other!, exact: true }).click()
      await expect(trigger).toHaveAccessibleName(`Model for the next reply: ${other}. Change it`)
      if (width === 390) await page.getByRole("button", { name: "Close", exact: true }).click()
      await expect(modelChip(page)).toHaveAccessibleName(modelName(other!))
    }
    // Manage connections…: Settings → Connections in this tab, the chat a Back away.
    await modelChip(page).click()
    await page.getByRole("link", { name: "Manage connections…" }).click()
    await expect(page).toHaveURL(/\/settings\/connections$/)
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/chats/${chatId}`))
  })
}

test("with no connection, the Model tab is the picker, and says where models come from", async ({ page }) => {
  await rpc((api) => api.CreateUser({ handle: "nell", displayName: "Nell", role: "user", password: "nell-password-1" }))
  const nell = await loginCookie(server(), "nell", "nell-password-1")
  const chat = await withCookie(server(), nell, (api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Rook", name: "Rook" })
      const created = yield* api.CreateChat({ title: "Rook's ledger" })
      yield* api.ChangeCast({ chatId: created.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      return created.id
    })
  )
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), "nell", "nell-password-1")
    await page.goto(`${server().url}/chats/${chat}`)
    const panel = await openPanel(page, "Model")
    await expect(panel.getByText("No connection lists a model yet.")).toBeVisible()
    await expect(panel.getByText("Choose a model in the composer")).toHaveCount(0)
    await panel.getByRole("button", { name: "Choose a model", exact: true }).click()
    await expect(page.getByRole("link", { name: "Add a connection…" }).first()).toBeVisible()
    await page.screenshot({ path: join(shots, `model-empty-${width}.png`) })
    await page.keyboard.press("Escape")
    await panel.getByRole("link", { name: "Add a connection…" }).click()
    await expect(page).toHaveURL(/\/settings\/connections$/)
  }
})

// Inserting messages anywhere in the history (spec/MESSAGE-INSERT.md §4; owner decision DESIGN
// §3.1, 2026-10-30): Insert message below and above from a message's "More actions", written
// or generated as two different cast members, Duplicate of a generated and of a written
// message, Undo from the toast and restore from the bin, the editor's cache and summary lines,
// renumbering, and a fork made before the insertion staying as it was. At 1440 and 390 pixels,
// light and dark. Every card and message here is made up.
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { ChatId, EntityId, ForkId, PathEntry, SlotId } from "@rp/shared/chat.ts"
import type { SendResult } from "@rp/shared/chatApi.ts"
import { Effect } from "effect"
import { messageMenu, showActions } from "./support/message.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { level1 } from "./support/summaries.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "8", FAKE_GENERATOR_TOKENS: "24" })

type Api = Parameters<Parameters<typeof asUser>[3]>[0]
const admin = <A>(use: (api: Api) => Effect.Effect<A, unknown>) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const shoot = async (page: Page, name: string) => {
  const dir = process.env.SCREENSHOT_DIR
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`) })
}

const messages = (page: Page) => page.locator("article[data-slot]")
const message = (page: Page, text: string) => messages(page).filter({ hasText: text })
const editor = (page: Page) => page.getByTestId("insert-editor")
/** The messages shown, in order, each as its number and its first words. */
const numbered = async (page: Page) =>
  (await messages(page).all()).length === 0
    ? []
    : await messages(page).evaluateAll((rows) =>
        rows.map((row) => {
          const number = [...row.querySelectorAll("header span")].find((s) => /^#\d+$/.test(s.textContent ?? ""))
          const text = row.querySelector(".markdown")?.textContent?.trim().slice(0, 24) ?? ""
          return `${number?.textContent ?? "?"} ${text}`
        })
      )

interface Fixture {
  readonly chatId: ChatId
  readonly main: ForkId
  readonly before: ForkId
  readonly entries: ReadonlyArray<PathEntry>
  readonly ids: Record<string, EntityId>
}

/** Mira and Tobin, the user playing Ana; three messages; a fork made at the last one before anything is inserted. */
const lighthouse = (title: string, lcm = false) =>
  admin((api) =>
    Effect.gen(function* () {
      const ids: Record<string, EntityId> = {}
      for (const name of ["Mira", "Tobin", "Ana"]) {
        const existing = (yield* api.ListCards()).find((card) => card.name === name)
        ids[name] = existing?.entityId ?? (yield* api.CreateCard({ label: name, name })).entityId
      }
      yield* api.SetPersona({ entityId: ids.Ana!, persona: true })
      const chat = yield* api.CreateChat({ title })
      for (const name of ["Mira", "Tobin", "Ana"])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: ids[name]! } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [ids.Ana!] } })
      let parent: SlotId | null = null
      for (const [speaker, content] of [
        ["Mira", "The lamp is lit."],
        ["Ana", "A ship rounds the point."],
        ["Mira", "The fog horn sounds."]
      ] as const) {
        const sent: SendResult = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content,
          speakerEntityId: ids[speaker]!
        })
        if (sent._tag !== "Posted") return yield* Effect.die(new Error("queued"))
        parent = sent.entry.slotId
      }
      const window = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 })
      const main = window.forkId!
      // A fork beside the main one, made before anything is inserted: it must stay as it is.
      const before = (yield* api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: parent })).fork.id
      if (lcm) yield* api.SetLcmEnabled({ chatId: chat.id, forkId: main, enabled: true })
      return { chatId: chat.id, main, before, entries: window.entries, ids }
    })
  )

const textsIn = (fixture: Fixture, forkId: ForkId) =>
  admin((api) =>
    Effect.map(
      api.ReadPath({ chatId: fixture.chatId, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 }),
      (window) => window.entries.map((e) => e.version.content)
    )
  )

const open = async (page: Page, fixture: Fixture) => {
  await page.goto(`${server().url}/chats/${fixture.chatId}?fork=${fixture.main}`)
  await expect(message(page, "The fog horn sounds.")).toBeVisible()
}

const speakerIn = (scope: Locator) => scope.getByRole("button", { name: /^Speaking as / })

test.beforeEach(async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})

for (const [width, height] of [
  [1440, 900],
  [390, 844]
] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`insert below, written and generated as two cast members, undo and restore (${width}px, ${theme})`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme })
      const title = `Lighthouse ${width} ${theme}`
      const fixture = await lighthouse(title)
      await open(page, fixture)
      const tag = `${width}-${theme}`

      // Below Mira's message: written as Ana, whom the user writes as.
      await messageMenu(message(page, "The lamp is lit."), "Insert message below")
      await expect(editor(page)).toBeVisible()
      await expect(speakerIn(editor(page))).toHaveAccessibleName(/^Speaking as Ana/)
      await expect(editor(page)).toContainText("The model will re-read")
      for (const name of ["Generate as Ana", "Insert", "Cancel", "Discard"])
        await expect(editor(page).getByRole("button", { name, exact: true })).toBeVisible()
      await editor(page).getByTestId("insert-text").fill("Ana steps onto the pier.")
      await shoot(page, `insert-editor-${tag}`)
      // Cancel keeps the text; opening it again there finds it.
      await editor(page).getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(editor(page)).toHaveCount(0)
      await messageMenu(message(page, "The lamp is lit."), "Insert message below")
      await expect(editor(page).getByTestId("insert-text")).toHaveValue("Ana steps onto the pier.")
      await editor(page).getByRole("button", { name: "Insert", exact: true }).click()
      await expect(editor(page)).toHaveCount(0)
      await expect(page.getByText("Message inserted")).toBeVisible()
      await expect
        .poll(() => numbered(page))
        .toEqual([
          "#1 The lamp is lit.",
          "#2 Ana steps onto the pier.",
          "#3 A ship rounds the point.",
          "#4 The fog horn sounds."
        ])
      await shoot(page, `insert-written-${tag}`)

      // Below Ana's message: generated as Mira, the character who spoke before it.
      await messageMenu(message(page, "A ship rounds the point."), "Insert message below")
      await expect(speakerIn(editor(page))).toHaveAccessibleName(/^Speaking as Mira/)
      await editor(page).getByRole("button", { name: "Generate as Mira", exact: true }).click()
      await expect(editor(page)).toHaveCount(0)
      await expect(messages(page)).toHaveCount(5)
      await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
      const generated = messages(page).nth(3)
      await expect(generated).toContainText("#4")
      await expect(generated).toContainText("Mira")
      await expect(messages(page).nth(4)).toContainText("The fog horn sounds.")
      await expect(messages(page).nth(4)).toContainText("#5")
      await shoot(page, `insert-generated-${tag}`)

      // Undo from its toast: to the bin. A message in the bin keeps its place, so the messages
      // after it keep their numbers, as after any delete.
      await page.getByRole("button", { name: "Undo" }).last().click()
      await expect(messages(page)).toHaveCount(4)
      await expect(message(page, "The fog horn sounds.")).toContainText("#5")
      // Restored from the bin, it's back where it was.
      await page.goto(`${server().url}/bin`)
      const item = page.getByRole("listitem").filter({ hasText: title }).first()
      await item.getByRole("button", { name: "Restore" }).click()
      await open(page, fixture)
      await expect(messages(page)).toHaveCount(5)
      await expect(messages(page).nth(3)).toContainText("#4")
      await expect(messages(page).nth(3)).toContainText("Mira")

      // The fork made before the insertions is as it was.
      expect(await textsIn(fixture, fixture.before)).toEqual([
        "The lamp is lit.",
        "A ship rounds the point.",
        "The fog horn sounds."
      ])
    })
  }
}

test("insert above the first message, duplicate written and generated messages, the summary line", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const fixture = await lighthouse("Harbor", true)
  await level1(server().dataDir, fixture.chatId, fixture.entries.slice(0, 2), "Mira lit the lamp; a ship came.")
  await open(page, fixture)

  // Inside summarized history: the editor says the summary is rewritten.
  await messageMenu(message(page, "The lamp is lit."), "Insert message below")
  await expect(editor(page)).toContainText("Inside summarized history: the summary is rewritten on the next reply.")
  // Summarized, it isn't lost before the history start: the rewritten summary carries it.
  await expect(editor(page)).not.toContainText("Before the model's history start")
  await shoot(page, "insert-summary-line")
  await editor(page).getByRole("button", { name: "Cancel", exact: true }).click()

  // Above the first message only: as Tobin, picked in the switcher.
  await showActions(message(page, "A ship rounds the point."))
  await message(page, "A ship rounds the point.").getByRole("button", { name: "More actions" }).click()
  await expect(page.getByRole("menuitem", { name: "Insert message above" })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await messageMenu(message(page, "The lamp is lit."), "Insert message above")
  await speakerIn(editor(page)).click()
  await page.getByRole("listbox", { name: "Cards" }).getByRole("option", { name: "Tobin" }).click()
  await expect(speakerIn(editor(page))).toHaveAccessibleName(/^Speaking as Tobin/)
  await editor(page).getByTestId("insert-text").fill("Tobin trims the wick first.")
  await editor(page).getByRole("button", { name: "Insert", exact: true }).click()
  await expect
    .poll(() => numbered(page))
    .toEqual([
      "#1 Tobin trims the wick fir",
      "#2 The lamp is lit.",
      "#3 A ship rounds the point.",
      "#4 The fog horn sounds."
    ])

  // Duplicate of a written message: the copy right below it.
  await messageMenu(message(page, "A ship rounds the point."), "Duplicate")
  await expect(page.getByText("Message duplicated")).toBeVisible()
  await expect(message(page, "A ship rounds the point.")).toHaveCount(2)
  await expect(messages(page).nth(3)).toContainText("#4")

  // A reply still being written can't be duplicated; once finished, it can.
  await admin((api) =>
    api.Generate({
      chatId: fixture.chatId,
      forkId: fixture.main,
      parentSlotId: fixture.entries.at(-1)!.slotId,
      branch: false
    })
  )
  const reply = messages(page).last()
  await expect(reply).toContainText("generating")
  await showActions(reply)
  await reply.getByRole("button", { name: "More actions" }).click()
  const duplicate = page.getByRole("menuitem", { name: /Duplicate/ })
  await expect(duplicate).toHaveAttribute("data-disabled")
  await expect(duplicate).toContainText("It's still being written.")
  await shoot(page, "insert-duplicate-disabled")
  await page.keyboard.press("Escape")
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
  const original = messages(page).last()
  const text = (await original.locator(".markdown").first().textContent())!.trim().slice(0, 40)
  const number = Number(/#(\d+)/.exec((await original.locator("header").first().textContent()) ?? "")![1])
  await messageMenu(original, "Duplicate")
  // The copy, right below it, numbered next; the list is virtualized, so by text, not by index.
  await expect(messages(page).filter({ hasText: text })).toHaveCount(2)
  await expect(messages(page).filter({ hasText: text }).last()).toContainText(`#${number + 1}`)
  await shoot(page, "insert-duplicated")

  // A message sent now goes below the fork's tip, after the duplicate shown last.
  await page.getByLabel("Message", { exact: true }).fill("The keeper waves.")
  await page.getByLabel("Message", { exact: true }).press("Enter")
  await expect(messages(page).filter({ hasText: "The keeper waves." })).toBeVisible()
  const texts = await textsIn(fixture, fixture.main)
  expect(texts.indexOf("The keeper waves.")).toBeGreaterThan(texts.length - 3)
  expect(await textsIn(fixture, fixture.before)).toEqual([
    "The lamp is lit.",
    "A ship rounds the point.",
    "The fog horn sounds."
  ])
})

// Inserting messages anywhere in the history (spec/MESSAGE-INSERT.md §4; owner decision DESIGN
// §3.1, 2026-10-30): Insert message below and above from a message's "More actions", written
// or generated as two different cast members, Duplicate of a generated and of a written
// message, Undo from the toast and restore from the bin, the cache chip's re-read and the editor's summary line,
// renumbering, and a fork made before the insertion staying as it was. At 1440 and 390 pixels,
// light and dark. Every card and message here is made up.
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { ChatId, EntityId, ForkId, PathEntry, SlotId } from "@rp/shared/chat.ts"
import type { SendResult } from "@rp/shared/chatApi.ts"
import { Effect } from "effect"
import { messageMenu, showActions } from "./support/message.ts"
import { loginCookie, withCookie, type Client as Api } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { cacheChip } from "./support/strip.ts"
import { level1 } from "./support/summaries.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "8", FAKE_GENERATOR_TOKENS: "24" })

let cookie = ""
const admin = <A>(use: (api: Api) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})

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
      // Two generations, an undo, a restore and the Cancel's recovered text: long on a shared host.
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      const title = `Lighthouse ${width} ${theme}`
      const fixture = await lighthouse(title)
      await open(page, fixture)
      const tag = `${width}-${theme}`

      // Below Mira's message: written as Ana, whom the user writes as.
      await messageMenu(message(page, "The lamp is lit."), "Insert message below")
      await expect(editor(page)).toBeVisible()
      await expect(speakerIn(editor(page))).toHaveAccessibleName(/^Speaking as Ana/)
      // What the next reply re-reads is the strip's cache chip's, while the editor is open.
      await expect(editor(page)).not.toContainText("The model will re-read")
      await expect(page.getByText(/^↻ re-reads \d+ messages?$/)).toBeAttached()
      if (width >= 640) {
        await cacheChip(page).click()
        await expect(page.getByRole("dialog", { name: "Cache", exact: true })).toContainText(
          /The model will re-read \d+ messages? on the next reply/
        )
        await page.keyboard.press("Escape")
        await expect(page.getByRole("dialog", { name: "Cache", exact: true })).toHaveCount(0)
      }
      for (const name of ["Generate as Ana", "Insert", "Cancel"])
        await expect(editor(page).getByRole("button", { name, exact: true })).toBeVisible()
      await expect(editor(page).getByRole("button", { name: "Discard", exact: true })).toHaveCount(0)
      // Cancel sends typed text to the bin's recovered texts; opening it again there finds it empty.
      const cancelled = `Ana waits on the steps (${tag}).`
      await editor(page).getByTestId("insert-text").fill(cancelled)
      await expect
        .poll(() =>
          admin((api) =>
            Effect.map(api.MessageDrafts({ chatId: fixture.chatId }), (ds) =>
              ds.some((d) => d.key.targetKind === "insert" && d.content === cancelled)
            )
          )
        )
        .toBe(true)
      await editor(page).getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(editor(page)).toHaveCount(0)
      await expect(page.getByText(/re-reads \d+ messages?/)).toHaveCount(0)
      await expect
        .poll(() =>
          admin((api) =>
            Effect.map(api.ListRecoveredTexts({ limit: 100, before: null }), (texts) =>
              texts.some((text) => text.content.includes(cancelled))
            )
          )
        )
        .toBe(true)
      await messageMenu(message(page, "The lamp is lit."), "Insert message below")
      await expect(editor(page).getByTestId("insert-text")).toHaveValue("")
      await editor(page).getByTestId("insert-text").fill("Ana steps onto the pier.")
      await shoot(page, `insert-editor-${tag}`)
      // A saved insertion draft reopens in its original place after a full reload.
      await expect
        .poll(() =>
          admin((api) =>
            Effect.map(api.MessageDrafts({ chatId: fixture.chatId }), (ds) =>
              ds.some((d) => d.key.targetKind === "insert" && d.content === "Ana steps onto the pier.")
            )
          )
        )
        .toBe(true)
      await page.reload()
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

      // A direction is used by Generate too, with an explicitly selected second cast member.
      await messageMenu(message(page, "The lamp is lit."), "Insert message below")
      await speakerIn(editor(page)).click()
      await page.getByRole("listbox", { name: "Cards" }).getByRole("option", { name: "Tobin" }).click()
      await editor(page).getByTestId("insert-text").fill("Mention the silver lantern.")
      await editor(page).getByRole("button", { name: "Generate as Tobin", exact: true }).click()
      await expect(editor(page)).toHaveCount(0)
      await expect(messages(page)).toHaveCount(6)
      await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
      const directed = await admin((api) =>
        Effect.map(
          api.ReadPath({
            chatId: fixture.chatId,
            forkId: fixture.main,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 50
          }),
          (w) => w.entries[1]!
        )
      )
      expect(directed.version.speakerEntityId).toBe(fixture.ids.Tobin)
      expect(directed.version.direction).toBe("Mention the silver lantern.")
      await shoot(page, `insert-directed-${tag}`)

      // The fork made before the insertions is as it was.
      expect(await textsIn(fixture, fixture.before)).toEqual([
        "The lamp is lit.",
        "A ship rounds the point.",
        "The fog horn sounds."
      ])
    })
  }
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`insert above, duplicate written and generated, summary line (${width}px, ${theme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      const fixture = await lighthouse("Harbor", true)
      await level1(server().dataDir, fixture.chatId, fixture.entries.slice(0, 2), "Mira lit the lamp; a ship came.")
      await open(page, fixture)

      // Inside summarized history: the editor says the summary is rewritten.
      await messageMenu(message(page, "The lamp is lit."), "Insert message below")
      await expect(editor(page)).toContainText("Inside summarized history: the summary is rewritten on the next reply.")
      // Summarized, it isn't lost before the history start: the rewritten summary carries it.
      await expect(editor(page)).not.toContainText("Before the model's history start")
      await shoot(page, `insert-summary-line-${width}-${theme}`)
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

      await messages(page).first().scrollIntoViewIfNeeded()
      await shoot(page, `insert-above-${width}-${theme}`)

      // Duplicate of a written message: the copy right below it.
      await messageMenu(message(page, "A ship rounds the point."), "Duplicate")
      await expect(page.getByText("Message duplicated")).toBeVisible()
      await expect(message(page, "A ship rounds the point.")).toHaveCount(2)
      await expect(messages(page).nth(3)).toContainText("#4")

      // Open the menu before starting the version: on a phone, tapping a streaming body can
      // wait for its moving layout to settle, by which time the short fixture has finished.
      // The open menu must react to a version starting in another tab.
      const tip = fixture.entries.at(-1)!
      const reply = page.locator(`article[data-slot="${tip.slotId}"]`)
      await showActions(reply)
      await reply.getByRole("button", { name: "More actions" }).click()
      await admin((api) =>
        api.Regenerate({ slotId: tip.slotId, forkId: fixture.main, expectedRowVersion: tip.rowVersion })
      )
      await expect(reply).toContainText("generating")
      const duplicate = page.getByRole("menuitem", { name: /Duplicate/ })
      await expect(duplicate).toHaveAttribute("data-disabled")
      await expect(duplicate).toContainText("It's still being written.")
      await shoot(page, `insert-duplicate-disabled-${width}-${theme}`)
      await page.keyboard.press("Escape")
      await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
      const original = messages(page).last()
      const text = (await original.locator(".markdown").first().textContent())!.trim().slice(0, 40)
      const number = Number(/#(\d+)/.exec((await original.locator("header").first().textContent()) ?? "")![1])
      await messageMenu(original, "Duplicate")
      // The copy, right below it, numbered next; the list is virtualized, so by text, not by index.
      await expect(messages(page).filter({ hasText: text })).toHaveCount(2)
      await expect(messages(page).filter({ hasText: text }).last()).toContainText(`#${number + 1}`)
      await shoot(page, `insert-duplicated-${width}-${theme}`)

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

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`duplicate display end, then append after a deleted tip (${width}px, ${theme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      const fixture = await lighthouse(`Deleted tip ${width} ${theme}`)
      await open(page, fixture)
      await messageMenu(message(page, "The fog horn sounds."), "Duplicate")
      await expect(message(page, "The fog horn sounds.")).toHaveCount(2)
      // Delete the structural tip through its visible action; the copy after it stays shown.
      await showActions(message(page, "The fog horn sounds.").first())
      await message(page, "The fog horn sounds.")
        .first()
        .getByRole("button", { name: "Delete message", exact: true })
        .click()
      await expect(message(page, "The fog horn sounds.")).toHaveCount(1)
      await page.getByLabel("Message", { exact: true }).fill("After the deleted anchor.")
      await page.getByRole("button", { name: "Send as Ana", exact: true }).click()
      await expect(message(page, "After the deleted anchor.")).toBeVisible()
      const entries = await admin((api) =>
        Effect.map(
          api.ReadPath({
            chatId: fixture.chatId,
            forkId: fixture.main,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 50
          }),
          (w) => w.entries
        )
      )
      const sent = entries.find((e) => e.version.content === "After the deleted anchor.")!
      expect(sent.parentSlotId).toBe(fixture.entries.at(-1)!.slotId)
      expect(entries[entries.indexOf(sent) - 1]!.inserted).toBe(true)
      expect(sent.position).toBe(4)
      await shoot(page, `insert-deleted-tip-${width}-${theme}`)
    })
  }

test("off-window branch numbers refresh after another tab inserts before them", async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const fixture = await lighthouse("Off-window insertion numbers")
  await admin((api) =>
    Effect.gen(function* () {
      // An alternate at message #2, then enough original history to page that branch point out.
      yield* api.SendMessage({
        chatId: fixture.chatId,
        forkId: fixture.main,
        parentSlotId: fixture.entries[0]!.slotId,
        branch: true,
        content: "The alternate harbor.",
        reply: false
      })
      let parent = fixture.entries.at(-1)!.slotId
      for (let n = 0; n < 150; n++) {
        const posted = yield* api.SendMessage({
          chatId: fixture.chatId,
          forkId: fixture.main,
          parentSlotId: parent,
          branch: false,
          content: `Synthetic history ${n}.`,
          reply: false
        })
        if (posted._tag !== "Posted") throw new Error("queued")
        parent = posted.entry.slotId
      }
    })
  )
  await page.goto(`${server().url}/chats/${fixture.chatId}?fork=${fixture.main}`)
  await expect(message(page, "Synthetic history 149.")).toBeVisible()
  await expect(message(page, "A ship rounds the point.")).toHaveCount(0)
  await expect(page.getByRole("button", { name: /at message #2.*switch branch/ })).toBeVisible()
  await admin((api) =>
    api.InsertMessage({
      chatId: fixture.chatId,
      forkId: fixture.main,
      anchor: null,
      expectedRowVersion: 0,
      body: { _tag: "Write", speaker: null, content: "Before the harbor." }
    })
  )
  await expect(page.getByRole("button", { name: /at message #3.*switch branch/ })).toBeVisible()
  await shoot(page, "insert-off-window-numbering")
})

test("another tab appends after an above-first insertion with a null structural tip", async ({ page, context }) => {
  const fixture = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Synthetic root gap" })
      yield* api.InsertMessage({
        chatId: chat.id,
        forkId: chat.currentForkId!,
        anchor: null,
        expectedRowVersion: 0,
        body: { _tag: "Write", speaker: null, content: "The opening before any structural message." }
      })
      const path = yield* api.ReadPath({
        chatId: chat.id,
        forkId: chat.currentForkId!,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 10
      })
      return { chat, path }
    })
  )
  expect(fixture.path.leafSlotId).toBeNull()
  const url = `${server().url}/chats/${fixture.chat.id}?fork=${fixture.chat.currentForkId}`
  await page.goto(url)
  await expect(message(page, "The opening before any structural message.")).toBeVisible()
  const second = await context.newPage()
  try {
    await second.goto(url)
    await expect(message(second, "The opening before any structural message.")).toBeVisible()
    await second.getByLabel("Message", { exact: true }).fill("The first ordinary message.")
    await second.getByRole("button", { name: "Send", exact: true }).click()
    await expect(message(page, "The first ordinary message.")).toBeVisible()
    await expect(message(page, "The first ordinary message.")).toContainText("#2")
    const path = await admin((api) =>
      api.ReadPath({
        chatId: fixture.chat.id,
        forkId: fixture.chat.currentForkId!,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 10
      })
    )
    const posted = path.entries.find((e) => e.version.content === "The first ordinary message.")!
    expect(posted.parentSlotId).toBeNull()
    expect(posted.position).toBe(1)
    await shoot(page, "insert-null-tip-two-tabs")
  } finally {
    await second.close()
  }
})

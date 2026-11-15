// Message spacing (job reading1; ST-COMPARISON "less story per screen"): Interface → Message
// spacing switches a chat between Comfortable (as before) and Compact. Switching keeps the text
// being read where it is on screen; at the end of the chat the list stays at the end. In Compact
// a message's version controls take no room: they show over its corner when it's pointed at or
// holds focus, and on a phone with its actions after a tap; the newest message keeps them. A
// reply streams, and messages are selected, as in Comfortable. The side chat, a workshop chat
// and a chat with threads follow the same choice. At 1440 and 390 px, light and dark, with the
// layout audit in both spacings. Synthetic messages only; replies come from the server's
// built-in test generator, never a provider.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test, type TestInfo } from "@playwright/test"
import type { ChatId, EntityId, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { messageMenu } from "./support/message.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({
  ...withAdmin,
  FAKE_GENERATOR_TPS: "25",
  FAKE_GENERATOR_TOKENS: "120",
  FAKE_GENERATOR_REASONING: "20"
})
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const shoot = async (page: Page, name: string) => {
  const dir = process.env.SCREENSHOT_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, `${name}.png`), animations: "disabled" })
}

/** A measurement kept with the test's result, and printed for the job's report. */
const note = (info: TestInfo, type: string, description: string) => {
  info.annotations.push({ type, description })
  console.log(`[${type}] ${description}`)
}

const COUNT = 60
/** A turn of a few short paragraphs, each findable by its text. */
const turn = (i: number) =>
  [
    `Turn ${i}, first paragraph. The harbor lamps come on one by one, and the gulls settle along the *wet* rope of the pier.`,
    `Turn ${i}, second paragraph. "We leave with the tide," she says, counting the crates again.`,
    i % 5 === 0 ? `- Turn ${i}, a list item about salt\n- Turn ${i}, a list item about rope` : null,
    i % 3 === 0 ? `Turn ${i}, last paragraph. Nobody answers; the water does.` : null
  ]
    .filter((part) => part !== null)
    .join("\n\n")

type Density = "comfortable" | "compact"
const setDensity = (chatDensity: Density) => admin((api) => api.SetDisplayPrefs({ prefs: { chatDensity } }))

/** Avani (the user's) and Mira take turns for `COUNT` messages. */
const seed = (title: string, count = COUNT) =>
  admin((api) =>
    Effect.gen(function* () {
      const mira = (yield* api.CreateCard({ label: `Mira ${title}`, name: "Mira" })).entityId as EntityId
      const avani = (yield* api.CreateCard({ label: `Avani ${title}`, name: "Avani" })).entityId as EntityId
      const chat = yield* api.CreateChat({ title })
      for (const entityId of [mira, avani])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [avani] } })
      let parent: SlotId | null = null
      for (let i = 1; i <= count; i++) {
        const sent = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          reply: false,
          content: turn(i),
          speakerEntityId: i % 2 === 1 ? avani : mira
        })
        if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
        parent = sent.entry.slotId as SlotId
      }
      return { chatId: chat.id as ChatId, forkId: chat.currentForkId!, mira, avani, tip: parent! }
    })
  )

const list = (page: Page) => page.getByTestId("messages")
const article = (scope: Page | Locator, i: number) =>
  scope.getByRole("article").filter({ hasText: `Turn ${i}, first paragraph.` })
const fromEnd = (page: Page) => list(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)

/** The first block of message text reaching below the list's top edge: its text and where it starts. */
const reading = (page: Page) =>
  list(page).evaluate((el) => {
    const top = el.getBoundingClientRect().top
    const block = [...el.querySelectorAll(".markdown > *")].find((b) => b.getBoundingClientRect().bottom > top + 1)
    return block ? { text: block.textContent, top: block.getBoundingClientRect().top - top } : null
  })
const topOf = (page: Page, text: string) =>
  list(page).evaluate((el, wanted) => {
    const block = [...el.querySelectorAll(".markdown > *")].find((b) => b.textContent === wanted)
    return block ? block.getBoundingClientRect().top - el.getBoundingClientRect().top : null
  }, text)

/** Samples, every frame, how far the block with `text` is from `top`; read with `stopWatching`. */
const watch = (page: Page, text: string, top: number) =>
  list(page).evaluate(
    (el, { text, top }) => {
      const state = { worst: 0, frames: 0, on: true }
      ;(window as unknown as { __reading: typeof state }).__reading = state
      const sample = () => {
        if (!state.on) return
        const block = [...el.querySelectorAll(".markdown > *")].find((b) => b.textContent === text)
        if (block) {
          const now = block.getBoundingClientRect().top - el.getBoundingClientRect().top
          state.worst = Math.max(state.worst, Math.abs(now - top))
        } else state.worst = Infinity
        state.frames++
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    },
    { text, top }
  )
const stopWatching = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as { __reading: { worst: number; frames: number; on: boolean } }).__reading
    state.on = false
    return { worst: state.worst, frames: state.frames }
  })

/** Picks a spacing in the Interface panel, as a user does. */
const choose = async (page: Page, density: Density, keepOpen = false) => {
  const tab = await openPanel(page, "Interface")
  const radio = tab.getByRole("radio", { name: density === "compact" ? /^Compact/ : /^Comfortable/ })
  await radio.scrollIntoViewIfNeeded()
  await radio.click()
  await expect(radio).toBeChecked()
  await expect(list(page)).toHaveAttribute("data-chat-density", density)
  if (!keepOpen) await closePanel(page)
}

/** How a message's version footer is laid out and whether it shows. */
const footer = (message: Locator) =>
  message.locator(".message-footer").evaluate((el) => {
    const style = getComputedStyle(el)
    return { display: style.display, position: style.position, opacity: style.opacity }
  })
const versions = (message: Locator) => message.getByRole("group", { name: "Versions" })

const open = async (page: Page, width: number, theme: "light" | "dark", url: string) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
  await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(url)
}

for (const width of [1440, 390] as const)
  for (const theme of ["light", "dark"] as const)
    test(`spacing: switch, place kept, actions, streaming, selection (${width}px, ${theme})`, async ({
      browser
    }, info) => {
      test.setTimeout(180_000)
      const phone = width === 390
      const context = await browser.newContext(phone ? { isMobile: true, hasTouch: true } : {})
      const page = await context.newPage()
      await setDensity("comfortable")
      const chat = await seed(`Spacing ${width} ${theme}`)
      await open(page, width, theme, `${server().url}/chats/${chat.chatId}`)
      await expect(article(page, COUNT)).toBeVisible()
      await expect(list(page)).toHaveAttribute("data-chat-density", "comfortable")
      await expectLayout(page, info, `comfortable end ${width} ${theme}`)
      await shoot(page, `comfortable-end-${width}-${theme}`)

      // The control is with the other chat display choices, and explains itself.
      const tab = await openPanel(page, "Interface")
      await expect(tab.getByRole("group", { name: "Message spacing" })).toBeVisible()
      await expect(tab.getByRole("radio", { name: /^Comfortable/ })).toBeChecked()
      await expectLayout(page, info, `interface panel ${width} ${theme}`)
      await shoot(page, `setting-${width}-${theme}`)
      await closePanel(page)

      // Reading in the middle of the chat: the text at the top of the view stays put both ways.
      await list(page).evaluate((el) => {
        el.scrollTop = Math.round(el.scrollHeight * 0.45) + 37
      })
      await page.waitForTimeout(500)
      await shoot(page, `comfortable-middle-${width}-${theme}`)
      const heights = (page: Page) =>
        list(page).evaluate((el) =>
          Object.fromEntries(
            [...el.querySelectorAll<HTMLElement>("article[data-slot]")].map((a) => [a.dataset.slot!, a.offsetHeight])
          )
        )
      const roomy = await heights(page)
      const shownRoomy = await list(page).evaluate(
        (el) =>
          [...el.querySelectorAll("article[data-slot]")].filter((a) => {
            const box = a.getBoundingClientRect()
            const view = el.getBoundingClientRect()
            return box.top >= view.top && box.bottom <= view.bottom
          }).length
      )
      for (const density of ["compact", "comfortable", "compact"] as const) {
        if (!phone) await openPanel(page, "Interface")
        await page.waitForTimeout(300)
        const before = (await reading(page))!
        expect(before).not.toBeNull()
        if (!phone) await watch(page, before.text, before.top)
        await choose(page, density, !phone)
        await expect.poll(async () => Math.abs(((await topOf(page, before.text)) ?? 1e6) - before.top)).toBeLessThan(2)
        await page.waitForTimeout(600)
        expect(Math.abs((await topOf(page, before.text))! - before.top)).toBeLessThan(2)
        if (!phone) {
          const seen = await stopWatching(page)
          note(info, "reading place", `${width} ${theme} to ${density}: worst frame ${seen.worst.toFixed(1)} px off`)
          // One frame may show the text a line off while the rows are measured again; never
          // another part of the chat.
          expect(seen.worst).toBeLessThan(40)
        }
      }
      if (!phone) await closePanel(page)
      await page.waitForTimeout(300)

      // Compact rows are shorter, and more of them fit.
      const tight = await heights(page)
      const both = Object.keys(tight).filter((slot) => slot in roomy)
      expect(both.length).toBeGreaterThan(0)
      for (const slot of both) expect(tight[slot]!).toBeLessThan(roomy[slot]!)
      const shownTight = await list(page).evaluate(
        (el) =>
          [...el.querySelectorAll("article[data-slot]")].filter((a) => {
            const box = a.getBoundingClientRect()
            const view = el.getBoundingClientRect()
            return box.top >= view.top && box.bottom <= view.bottom
          }).length
      )
      note(
        info,
        "density",
        `${width} ${theme}: whole messages in view ${shownRoomy} → ${shownTight}; heights ${both
          .map((slot) => `${roomy[slot]}→${tight[slot]}`)
          .join(", ")}`
      )
      expect(shownTight).toBeGreaterThanOrEqual(shownRoomy)
      await expectLayout(page, info, `compact middle ${width} ${theme}`)
      await shoot(page, `compact-middle-${width}-${theme}`)

      // A message in the middle: its version controls take no room until it's pointed at,
      // focused, or (on a phone) tapped; its actions come the same way.
      const middle = page
        .locator("article[data-slot]")
        .filter({ has: page.locator(".markdown") })
        .nth(2)
      await middle.scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      if (phone) {
        expect((await footer(middle)).display).toBe("none")
        await middle.locator(".markdown").first().tap()
        const toolbar = middle.getByRole("toolbar", { name: "Message actions" })
        await expect(toolbar).toBeVisible()
        await expect(versions(middle)).toBeVisible()
        await expect(middle.getByRole("button", { name: "More actions" })).toBeVisible()
        // Revealed, every control is a touch target as large as in Comfortable.
        for (const button of await middle.locator(".message-footer button").all()) {
          const box = (await button.boundingBox())!
          expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(28)
        }
        await expect(versions(middle)).toBeInViewport({ ratio: 1 })
        await expectLayout(page, info, `compact revealed ${width} ${theme}`, { hovered: true })
        await shoot(page, `compact-revealed-${width}-${theme}`)
        await middle.getByRole("button", { name: "More actions" }).tap()
        await expect(page.getByRole("menuitem", { name: "Select messages" })).toBeVisible()
        await page.keyboard.press("Escape")
        await middle.locator(".markdown").first().tap()
        await expect(middle.getByRole("toolbar", { name: "Message actions" })).toHaveCount(0)
        expect((await footer(middle)).display).toBe("none")
      } else {
        await page.mouse.move(0, 0)
        await expect.poll(async () => (await footer(middle)).opacity).toBe("0")
        expect((await footer(middle)).position).toBe("absolute")
        await middle.hover()
        await expect.poll(async () => (await footer(middle)).opacity).toBe("1")
        await expect(middle.getByRole("toolbar", { name: "Message actions" })).toHaveCSS("opacity", "1")
        await expectLayout(page, info, `compact hovered ${width} ${theme}`, { hovered: true })
        await shoot(page, `compact-hovered-${width}-${theme}`)
        // The controls are really on top there, so a click reaches them; and the actions are
        // as tall as the name row, still a fair target for a mouse.
        expect(
          await versions(middle).evaluate((group) => {
            const box = group.getBoundingClientRect()
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
            return hit !== null && group.contains(hit)
          })
        ).toBe(true)
        for (const button of await middle.getByRole("toolbar", { name: "Message actions" }).getByRole("button").all()) {
          const box = (await button.boundingBox())!
          expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24)
        }
        await page.mouse.move(0, 0)
        await expect.poll(async () => (await footer(middle)).opacity).toBe("0")
        // The keyboard reaches them too.
        await middle.getByRole("button", { name: "More actions" }).focus()
        await expect.poll(async () => (await footer(middle)).opacity).toBe("1")
        await page.keyboard.press("Tab")
        await expect.poll(async () => (await footer(middle)).opacity).toBe("1")
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      }

      // The newest message keeps its version controls in view.
      await list(page).evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1)
      const last = article(page, COUNT)
      await page.mouse.move(0, 0)
      await expect(versions(last)).toBeVisible()
      expect((await footer(last)).position).not.toBe("absolute")
      expect((await footer(last)).display).not.toBe("none")
      await expectLayout(page, info, `compact end ${width} ${theme}`)
      await shoot(page, `compact-end-${width}-${theme}`)

      // Selecting messages: every row shows its tick, in line with its portrait.
      await messageMenu(last, "Select messages")
      const bar = page.getByRole("region", { name: "Selected messages" })
      await expect(bar).toContainText("1 message selected")
      const tick = (row: Locator) => row.getByRole("checkbox", { name: "Select this message", exact: true })
      await expect(tick(last)).toBeChecked()
      await expect(tick(article(page, COUNT - 1))).toBeVisible()
      await tick(article(page, COUNT - 1)).click()
      await expect(bar).toContainText("2 messages selected")
      await expectLayout(page, info, `compact selection ${width} ${theme}`)
      await shoot(page, `compact-selection-${width}-${theme}`)
      await bar.getByRole("button", { name: "Cancel" }).click()
      await expect(page.getByRole("checkbox", { name: "Select this message" })).toHaveCount(0)

      // A reply streams at the end of a compact list: it shows its Stop, and the list follows it.
      await list(page).evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await page.waitForTimeout(400)
      const posted = await admin((api) =>
        api.Generate({ chatId: chat.chatId, parentSlotId: chat.tip, branch: false, speakerEntityId: chat.mira })
      )
      expect(posted._tag).toBe("Posted")
      const reply = page.getByRole("article", { name: "Reply", exact: true }).last()
      await expect(reply.getByRole("button", { name: "Stop", exact: true })).toBeVisible({ timeout: 20_000 })
      await expect(reply.getByText("generating", { exact: true })).toBeVisible()
      const worstEnd: Array<number> = []
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(250)
        worstEnd.push(await fromEnd(page))
      }
      expect(Math.max(...worstEnd)).toBeLessThanOrEqual(48)
      await shoot(page, `compact-streaming-${width}-${theme}`)
      await expect(reply.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout: 30_000 })
      await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1)
      // Its thinking panel and its version controls, the newest message's, are there.
      await expect(reply.locator("[data-reasoning-panel]").first()).toBeVisible()
      await expect(versions(reply)).toBeVisible()
      await expectLayout(page, info, `compact reply ${width} ${theme}`)
      await shoot(page, `compact-reply-${width}-${theme}`)

      // At the end of the chat, switching keeps the end in view.
      await choose(page, "comfortable")
      await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1)
      await choose(page, "compact")
      await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1)
      await expect(reply).toBeInViewport()

      // The choice is the account's: a reload opens compact.
      await page.reload()
      await expect(list(page)).toHaveAttribute("data-chat-density", "compact")
      await expect(page.getByRole("article", { name: "Reply", exact: true }).last()).toBeVisible()
      await context.close()
    })

for (const width of [1440, 390] as const)
  for (const theme of ["light", "dark"] as const)
    test(`compact in a workshop, its side chat and a chat with threads (${width}px, ${theme})`, async ({
      page
    }, info) => {
      test.setTimeout(120_000)
      await setDensity("compact")
      const story = await seed(`Threads ${width} ${theme}`, 8)
      const workshop = await admin((api) =>
        Effect.gen(function* () {
          const made = yield* api.CreateWorkshop({ attachTo: story.chatId })
          const path = yield* api.ReadPath({ chatId: made.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
          let parent = path.entries.at(-1)?.slotId ?? null
          for (let i = 1; i <= 4; i++) {
            const sent = yield* api.SendMessage({
              chatId: made.id,
              parentSlotId: parent,
              branch: false,
              reply: false,
              content: turn(i)
            })
            if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
            parent = sent.entry.slotId
          }
          return made
        })
      )
      await admin((api) =>
        Effect.gen(function* () {
          const entry = (yield* api.ReadPath({
            chatId: story.chatId,
            forkId: story.forkId,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 1
          })).entries[0]!
          yield* api.StartThreads({
            chatId: story.chatId,
            forkId: story.forkId,
            slotId: entry.slotId,
            expectedRowVersion: entry.rowVersion,
            threads: [
              { name: "Market", cast: [story.mira, story.avani], writesAs: null },
              { name: "Harbor", cast: [story.mira], writesAs: null }
            ]
          })
        })
      )
      // The story with its threads row, and the workshop beside it.
      await open(page, width, theme, `${server().url}/chats/${story.chatId}?panel=workshop&workshop=${workshop.id}`)
      const side = page.locator(`[data-side-chat="${workshop.id}"]`)
      await expect(side.getByTestId("side-chat-messages")).toHaveAttribute("data-chat-density", "compact")
      await expect(article(side, 4)).toBeVisible()
      await expectLayout(page, info, `compact side chat ${width} ${theme}`)
      await shoot(page, `compact-side-chat-${width}-${theme}`)
      if (width === 390) await closePanel(page)
      await expect(list(page)).toHaveAttribute("data-chat-density", "compact")
      await expect(list(page).getByText("Market", { exact: false }).first()).toBeVisible()
      await expectLayout(page, info, `compact threads ${width} ${theme}`)
      await shoot(page, `compact-threads-${width}-${theme}`)

      // The workshop as a chat of its own keeps its look, compact.
      await page.goto(`${server().url}/chats/${workshop.id}`)
      await expect(list(page)).toHaveAttribute("data-chat-density", "compact")
      await expect(article(page, 4)).toBeVisible()
      await expect(page.locator("[data-chat-kind]").first()).toBeVisible()
      await expectLayout(page, info, `compact workshop ${width} ${theme}`)
      await shoot(page, `compact-workshop-${width}-${theme}`)
      await setDensity("comfortable")
    })

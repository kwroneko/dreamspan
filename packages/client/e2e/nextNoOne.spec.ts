// Next's No one (owner, 2026-11-06; DESIGN §2.3): while it's chosen, what you send gets no reply,
// through a reload and in a second tab, until another choice under Next. A pick under it is one
// reply, then No one again; an empty Send still asks Auto's pick for one reply. Every card here is made up.
import { expect, type Page, test } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { choices, nextChip, nextName, nextReply, pickReply } from "./support/strip.ts"

const server = serverPerFile({
  ...withAdmin,
  FAKE_GENERATOR_TPS: "400",
  FAKE_GENERATOR_TOKENS: "20",
  FAKE_GENERATOR_SEED: "1"
})
let adminCookie: string
test.beforeAll(async () => {
  adminCookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
test.beforeEach(async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})
const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), adminCookie, use)

const NO_ONE = "Next: no one, until you choose otherwise. Choose who replies next"
const composer = (page: Page) => page.getByLabel("Message", { exact: true })
const generating = (page: Page) => page.getByText("generating", { exact: true })
const whoReplies = (page: Page) => choices(page, "Who replies next")
const turns = (page: Page) => page.locator("article[data-slot]")
const lastHeader = (page: Page) => turns(page).last().locator("header").first()

/** Mira always passes Auto's roll; Tobin never does unless named or picked. */
const importCard = async (name: string, talkativeness: number) => {
  const response = await fetch(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    method: "POST",
    headers: { origin: server().url, cookie: adminCookie, "content-type": "application/octet-stream" },
    body: JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name, extensions: { talkativeness } } })
  })
  expect(response.status).toBe(200)
}
const TALKATIVENESS: Record<string, number> = { Mira: 1, Tobin: 0 }

/** A chat with `characters`, played as Ana (a persona), one reply at a time unless `rounds`. */
const chatWith = async (characters: ReadonlyArray<string>, rounds = false) => {
  const known = await admin((api) => api.ListCards())
  for (const name of characters)
    if (!known.some((card) => card.name === name)) await importCard(name, TALKATIVENESS[name] ?? 0.5)
  return admin((api) =>
    Effect.gen(function* () {
      const ids: Record<string, EntityId> = {}
      for (const name of [...characters, "Ana"]) {
        const existing = (yield* api.ListCards()).find((card) => card.name === name)
        ids[name] = existing?.entityId ?? (yield* api.CreateCard({ label: name, name })).entityId
        if (name === "Ana") yield* api.SetPersona({ entityId: ids[name], persona: true })
      }
      const chat = yield* api.CreateChat({ title: characters.join(" and ") || "Alone" })
      for (const name of [...characters, "Ana"])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: ids[name]! } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [ids.Ana!] } })
      if (!rounds) yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "ReplySingle", on: true } })
      return chat.id
    })
  )
}

const chooseNoOne = async (page: Page) => {
  await nextChip(page).click()
  const row = whoReplies(page).getByRole("radio", { name: "No one", exact: true })
  await expect(row).toHaveAccessibleDescription("No reply to what you send, until you choose otherwise")
  await row.click()
  await expect(whoReplies(page)).toHaveCount(0)
  await expect(nextChip(page)).toHaveAccessibleName(NO_ONE)
}

/** Sends `text` as Ana and waits until it's the last turn, with nothing generating after it. */
const sendQuietly = async (page: Page, text: string) => {
  const before = await turns(page).count()
  await composer(page).fill(text)
  await page.getByRole("button", { name: "Send as Ana", exact: true }).click()
  await expect(turns(page)).toHaveCount(before + 1)
  await expect(lastHeader(page)).toContainText("Ana")
  // Long enough for a reply to have started, were one asked for.
  await page.waitForTimeout(1500)
  await expect(turns(page)).toHaveCount(before + 1)
  await expect(generating(page)).toHaveCount(0)
}

test("No one in a group: sends get no reply until Auto, a pick is one reply, an empty Send asks", async ({ page }) => {
  const chatId = await chatWith(["Mira", "Tobin"], true)
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(nextChip(page)).toHaveAccessibleName(/^Next: Mira/)
  await chooseNoOne(page)
  await nextChip(page).click()
  await expect(whoReplies(page).getByRole("radio", { name: "No one", exact: true })).toBeChecked()
  await expect(page.getByText("then No one again.")).toBeVisible()
  await whoReplies(page).getByRole("radio", { name: "No one", exact: true }).hover()
  await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(
    "Stops replies to what you send, until you choose otherwise here."
  )
  await page.keyboard.press("Escape")
  // A name in the box doesn't make anyone reply.
  await composer(page).fill("Mira, Tobin?")
  await page.getByRole("button", { name: "Send as Ana", exact: true }).hover()
  await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(
    "Send as Ana, with no reply"
  )
  await sendQuietly(page, "Mira, Tobin?")
  await sendQuietly(page, "Still there?")

  // It stays chosen through a reload and shows in a second tab.
  await page.reload()
  await expect(nextChip(page)).toHaveAccessibleName(NO_ONE)
  const second = await page.context().newPage()
  await second.goto(`${server().url}/chats/${chatId}`)
  await expect(nextChip(second)).toHaveAccessibleName(NO_ONE)

  // A pick is for one reply, with no round; then No one again, in both tabs.
  await pickReply(page, "Tobin")
  await expect(nextChip(page)).toHaveAccessibleName(nextName("Tobin"))
  await expect(nextChip(second)).toHaveAccessibleName(nextName("Tobin"))
  await composer(page).fill("Tobin, the door.")
  await page.keyboard.press("Enter")
  await expect(lastHeader(page)).toContainText("Tobin")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  await expect(nextChip(page)).toHaveAccessibleName(NO_ONE)
  await expect(nextChip(second)).toHaveAccessibleName(NO_ONE)
  await sendQuietly(page, "Thank you.")

  // With nothing typed, Send asks Auto's pick for one reply, and No one stays.
  await page.getByRole("button", { name: "Mira replies", exact: true }).click()
  await expect(lastHeader(page)).toContainText("Mira")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  await expect(nextChip(page)).toHaveAccessibleName(NO_ONE)

  // Auto goes back to replies, from the other tab.
  await pickReply(second, null)
  // Mira spoke last, so with nothing typed Auto names Tobin; a message is answered by Mira's roll.
  await expect(nextChip(page)).toHaveAccessibleName(nextName("Tobin"))
  await second.close()
  await composer(page).fill("And now?")
  await page.keyboard.press("Enter")
  await expect(lastHeader(page)).toContainText("Mira")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
})

test("No one in a one-character chat, and apart from a chat with no one to reply", async ({ page }) => {
  const chatId = await chatWith(["Mira"])
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(nextChip(page)).toHaveAccessibleName(nextName("Mira"))
  await chooseNoOne(page)
  await expect(nextReply(page).getByRole("button", { name: NO_ONE })).toBeEnabled()
  await sendQuietly(page, "Hello?")
  await page.getByRole("button", { name: "Mira replies", exact: true }).click()
  await expect(lastHeader(page)).toContainText("Mira")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  await expect(nextChip(page)).toHaveAccessibleName(NO_ONE)

  // With no character, the chip stays disabled and plain: "Next: no one", not the choice.
  const empty = await chatWith([])
  await page.goto(`${server().url}/chats/${empty}`)
  await expect(nextChip(page)).toHaveAccessibleName("Next: no one. Choose who replies next")
  await expect(nextChip(page)).toBeDisabled()
})

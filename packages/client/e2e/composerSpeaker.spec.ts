// Who speaks and who replies at the composer (ST-GRIPES E4, D8; DESIGN §2.2): the strip's
// "Next" chip with Auto's pick (by talkativeness, or a name in the message) and a pick for one reply, an empty Send asking for the reply alone,
// Generate saying whose turn it writes, a speaker that stays chosen through a reload and in
// a second tab, and the switcher's search. Every card here is made up.
import { expect, type Page, test } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { choices, nextChip, nextName, nextReply, pickReply } from "./support/strip.ts"
import { openPanel } from "./support/panel.ts"

// Seed 1's prose mentions none of this file's cast. Random synthetic names can
// legitimately override talkativeness, changing Auto's next pick after a reply.
const server = serverPerFile({
  ...withAdmin,
  FAKE_GENERATOR_TPS: "400",
  FAKE_GENERATOR_TOKENS: "40",
  FAKE_GENERATOR_SEED: "1"
})
// One session for the file's setup calls: the server allows 50 logins per address in 15 minutes.
let adminCookie: string
test.beforeAll(async () => {
  adminCookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), adminCookie, use)

const composer = (page: Page) => page.getByLabel("Message", { exact: true })
const generating = (page: Page) => page.getByText("generating", { exact: true })
const whoReplies = (page: Page) => choices(page, "Who replies next")
/** The composer switcher's first section: the chat's cast, without the persona folder below it. */
const speakAs = (page: Page) => page.getByRole("group", { name: "Speak as", exact: true })
const speakerChip = (page: Page) => page.getByRole("button", { name: /^Speaking as / })
const lastHeader = (page: Page) => page.locator("article[data-slot]").last().locator("header").first()

/**
 * Each character's chance to reply (`extensions.talkativeness`), so Auto's pick is known: Mira
 * always passes the roll and Tobin and Wren never do, so they reply when named or picked, or
 * when no one else is left (ST's natural order, replyPolicy.ts). Others keep ST's default.
 */
const TALKATIVENESS: Record<string, number> = { Mira: 1, Tobin: 0, Wren: 0 }
const importCard = async (name: string, talkativeness: number) => {
  const response = await fetch(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    method: "POST",
    headers: { origin: server().url, cookie: adminCookie, "content-type": "application/octet-stream" },
    body: JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name, extensions: { talkativeness } } })
  })
  expect(response.status).toBe(200)
}

/**
 * A chat with `characters`, played as Ana (a persona), with no messages yet. With `withBo`, Bo,
 * another persona card, is in the cast too, unselected: a chat has at most one selected persona,
 * so Bo is an ordinary cast member the user can speak as (DESIGN §2.2, owner 2026-10-29).
 */
const chatWith = async (characters: ReadonlyArray<string>, withBo = false) => {
  const known = await admin((api) => api.ListCards())
  for (const name of characters)
    if (TALKATIVENESS[name] !== undefined && !known.some((card) => card.name === name))
      await importCard(name, TALKATIVENESS[name])
  return admin((api) =>
    Effect.gen(function* () {
      const ids: Record<string, EntityId> = {}
      const cast = [...characters, "Ana", ...(withBo ? ["Bo"] : [])]
      for (const name of cast) {
        const existing = (yield* api.ListCards()).find((card) => card.name === name)
        ids[name] = existing?.entityId ?? (yield* api.CreateCard({ label: name, name })).entityId
        if (name === "Ana" || name === "Bo") yield* api.SetPersona({ entityId: ids[name], persona: true })
      }
      const chat = yield* api.CreateChat({ title: characters.length > 1 ? "The Lantern" : characters[0]! })
      for (const name of cast)
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: ids[name]! } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [ids.Ana!] } })
      // One reply at a time: these check Auto's pick, the first of a round (rounds: replyRounds.spec.ts).
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "ReplySingle", on: true } })
      return chat.id
    })
  )
}

test.beforeEach(async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})

for (const [width, height] of [
  [1440, 900],
  [390, 844]
] as const) {
  for (const turns of [3, 82]) {
    test(`the pick follows the tip after deleting and restoring the last turn (${turns} turns, ${width}px)`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height })
      const chatId = await chatWith(["Mira", "Tobin"])
      const last = await admin((api) =>
        Effect.gen(function* () {
          const cards = yield* api.ListCards()
          const entity = (name: string) => cards.find((card) => card.name === name)!.entityId
          let parent = null as import("@rp/shared/chat.ts").SlotId | null
          for (let index = 0; index < turns; index++) {
            const sent = yield* api.SendMessage({
              chatId,
              parentSlotId: parent,
              branch: false,
              content:
                index === 0 ? "Mira's earlier turn" : index === turns - 1 ? "Tobin, a word?" : `Ana's turn ${index}`,
              speakerEntityId: entity(index === 0 ? "Mira" : "Ana")
            })
            if (sent._tag !== "Posted") throw new Error("Expected a posted turn")
            parent = sent.entry.slotId
          }
          return parent!
        })
      )
      await page.goto(`${server().url}/chats/${chatId}`)
      // The chips are always shown, a phone's too: who's next, and Auto naming them. The last
      // turn names Tobin, who otherwise never passes the roll.
      await expect(nextChip(page)).toHaveAccessibleName(nextName("Tobin"))
      await nextChip(page).click()
      await expect(whoReplies(page).getByRole("radio", { name: "Auto: Tobin", exact: true })).toBeChecked()
      await page.keyboard.press("Escape")
      await expect(whoReplies(page)).toHaveCount(0)
      if (turns > 60) await expect(page.getByText("Mira's earlier turn", { exact: true })).toHaveCount(0)
      // Without that turn no one is named, and Mira's roll always passes.
      const deleted = await admin((api) => api.DeleteMessage({ slotId: last }))
      await expect(nextChip(page)).toHaveAccessibleName(nextName("Mira"))
      await expect(page.getByRole("button", { name: "Mira replies", exact: true })).toBeEnabled()
      await admin((api) => api.RestoreBinItem({ itemId: deleted.id }))
      await expect(nextChip(page)).toHaveAccessibleName(nextName("Tobin"))
      // Delete again, then verify both send paths actually use the corrected pick.
      await admin((api) => api.DeleteMessage({ slotId: last }))
      await expect(nextChip(page)).toHaveAccessibleName(nextName("Mira"))
      if (turns === 3) {
        await composer(page).fill("A new persona turn after deletion.")
        await page.getByRole("button", { name: "Send as Ana", exact: true }).click()
      } else await page.getByRole("button", { name: "Mira replies", exact: true }).click()
      await expect(lastHeader(page)).toContainText("Mira")
      await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
    })
  }

  test(`the switcher lists only the chat's cast, and picking never adds a card (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    const chatId = await chatWith(["Mira", "Tobin"], true)
    // A library card that isn't in the chat: to speak as it, it has to be added first (DESIGN §2.2).
    await admin((api) =>
      Effect.gen(function* () {
        if (!(yield* api.ListCards()).some((card) => card.name === "Harbor Guard"))
          yield* api.CreateCard({ label: "Harbor Guard", name: "Harbor Guard" })
      })
    )
    await page.goto(`${server().url}/chats/${chatId}`)
    const search = page.getByRole("combobox", { name: "Find someone to speak as, or a persona", exact: true })
    await speakerChip(page).click()
    await expect(search).toBeFocused()
    await expect(page.getByRole("tab")).toHaveCount(0)
    await expect(speakAs(page).getByRole("option")).toHaveText(
      // The selected persona first, then the rest of the cast in its order.
      ["Ana", "Mira", "Tobin", "Bo"].map((name) => new RegExp(name)),
      {
        useInnerText: true
      }
    )
    await expect(page.getByText("adds to this chat")).toHaveCount(0)
    if (process.env.RP_SCREENS) await page.screenshot({ path: `${process.env.RP_SCREENS}/speaker-cast-${width}.png` })
    await page.keyboard.type("Harbor")
    await expect(page.getByRole("option")).toHaveCount(0)
    await expect(page.getByText("No one in this chat is called “Harbor”.")).toBeVisible()
    // Adding a card is the Cast tab's, a button away.
    await expect(speakAs(page).getByRole("button", { name: "Add to chat", exact: true })).toBeVisible()
    await search.fill("Bo")
    await search.press("Enter")
    await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Bo/)
    const cast = await admin((api) => api.GetCast({ chatId, slotId: null }))
    expect(cast.participants).toHaveLength(4)
  })
}

test("Next: Auto's pick, a name in the box, a pick for one reply, and an empty Send", async ({ page }) => {
  const chatId = await chatWith(["Mira", "Tobin", "Wren"])
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Ana/)
  await expect(nextChip(page)).toHaveAccessibleName(nextName("Mira"))
  await expect(nextReply(page).getByRole("button", { name: "Mira replies now", exact: true })).toBeEnabled()
  // Auto and the characters only: the cards the user plays never reply.
  await nextChip(page).click()
  await expect(whoReplies(page).getByRole("radio")).toHaveCount(4)
  await expect(whoReplies(page).getByRole("radio", { name: /^(Mira|Tobin|Wren)$/ })).toHaveCount(3)
  await expect(whoReplies(page).getByRole("radio", { name: "Ana", exact: true })).toHaveCount(0)
  await expect(whoReplies(page).getByRole("radio", { name: "Auto: Mira", exact: true })).toBeChecked()
  await page.keyboard.press("Escape")
  await expect(whoReplies(page)).toHaveCount(0)

  await composer(page).fill("The lantern gutters.")
  await page.keyboard.press("Enter")
  await expect(lastHeader(page)).toContainText("Mira")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  // Mira doesn't answer herself unasked; naming someone in the box makes them the one to reply.
  await expect(nextChip(page)).not.toHaveAccessibleName(nextName("Mira"))
  await composer(page).fill("Tobin, the door?")
  await expect(nextChip(page)).toHaveAccessibleName(nextName("Tobin"))
  await composer(page).fill("")
  await expect(nextChip(page)).not.toHaveAccessibleName(nextName("Mira"))

  // A pick is for one reply, kept on the server until it's used.
  await pickReply(page, "Wren")
  await expect(nextChip(page)).toHaveAccessibleName(nextName("Wren"))
  await page.reload()
  await expect(nextChip(page)).toHaveAccessibleName(nextName("Wren"))
  await nextChip(page).click()
  await expect(whoReplies(page).getByRole("radio", { name: "Wren", exact: true })).toBeChecked()
  await expect(whoReplies(page).getByRole("radio", { name: /^Auto: (Tobin|Wren)$/ })).not.toBeChecked()
  await page.keyboard.press("Escape")
  // With nothing typed, Send asks for that reply alone.
  await page.getByRole("button", { name: "Wren replies", exact: true }).click()
  await expect(lastHeader(page)).toContainText("Wren")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  // The pick is used up: Auto again, and Mira's roll always passes.
  await expect(nextChip(page)).toHaveAccessibleName(nextName("Mira"))
  await nextChip(page).click()
  await expect(whoReplies(page).getByRole("radio", { name: "Auto: Mira", exact: true })).toBeChecked()
  await page.keyboard.press("Escape")

  // Generate says whose turn it writes: the persona's, for the user.
  const write = page.getByRole("button", { name: "Generate Ana" })
  await expect(write).toBeVisible()
  await write.click()
  await expect(lastHeader(page)).toContainText("Ana")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
})

test("Manual order posts an image-only message without requesting a reply", async ({ page }) => {
  const chatId = await chatWith(["Mira", "Tobin"])
  await admin((api) => api.ChangeCast({ chatId, slotId: null, change: { _tag: "ReplyOrder", order: "manual" } }))
  const submissions: string[] = []
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      if (String(payload).includes('"tag":"SendMessage"')) submissions.push(String(payload))
    })
  )
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Ana/)
  await expect(page.getByRole("button", { name: "Attach images", exact: true })).toBeEnabled()
  const buffer = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 16
      canvas.getContext("2d")!.fillRect(0, 0, 16, 16)
      return canvas.toDataURL("image/png").split(",")[1]!
    }),
    "base64"
  )
  await page.getByLabel("Choose images").setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer })
  await expect(page.getByRole("list", { name: "Attached images" }).getByRole("img")).toHaveCount(1)
  await expect(nextChip(page)).toHaveAccessibleName(nextName("no one"))
  await page.getByRole("button", { name: "Send as Ana", exact: true }).click()
  await expect(page.getByRole("list", { name: "Attached images" })).toHaveCount(0)
  expect(submissions).toHaveLength(1)
  expect(submissions[0]).toContain('"reply":false')
  await expect(page.locator("article[data-slot]")).toHaveCount(1)
  await expect(lastHeader(page)).toContainText("Ana")
  await page.reload()
  await expect(page.locator("article[data-slot]")).toHaveCount(1)
  await expect(page.getByRole("button", { name: "View image 1", exact: true })).toBeVisible()
})

test("the speaker stays chosen through a reload and in every tab; the switcher searches", async ({ page }) => {
  const chatId = await chatWith(["Mira", "Tobin"], true)
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Ana/)

  // The search field has focus as the switcher opens; type part of a name, then Enter.
  await speakerChip(page).click()
  const search = page.getByRole("combobox", { name: "Find someone to speak as, or a persona", exact: true })
  await expect(search).toBeFocused()
  await page.keyboard.type("bo")
  await expect(speakAs(page).getByRole("option")).toHaveCount(1)
  await expect(speakAs(page).getByRole("option", { name: /Bo/ })).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Enter")
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Bo/)

  // Arrow keys move through what's left; Escape closes without a change.
  await speakerChip(page).click()
  await page.keyboard.type("i")
  await expect(speakAs(page).getByRole("option")).toHaveCount(2)
  await page.keyboard.press("ArrowDown")
  await expect(speakAs(page).getByRole("option", { name: /Tobin/ })).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Escape")
  await expect(search).toBeHidden()
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Bo/)

  // Kept on the server with the composer: a reload, and a second tab, speak as Bo.
  await page.reload()
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Bo/)
  const second = await page.context().newPage()
  await second.goto(`${server().url}/chats/${chatId}`)
  await expect(speakerChip(second)).toHaveAccessibleName(/^Speaking as Bo/)
  // A change in one tab shows in the other.
  await speakerChip(second).click()
  await second.keyboard.type("ana")
  await second.keyboard.press("Enter")
  await expect(speakerChip(second)).toHaveAccessibleName(/^Speaking as Ana/)
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Ana/)
  await second.close()
})

test("a one-card chat keeps a disabled Next chip, and an empty Send asks its character", async ({ page }) => {
  const chatId = await chatWith(["Mira"])
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Ana/)
  await expect(nextReply(page)).toBeVisible()
  await expect(nextChip(page)).toBeDisabled()
  await expect(nextReply(page).getByRole("button", { name: /replies now$/ })).toBeDisabled()
  await page.getByRole("button", { name: "Mira replies", exact: true }).click()
  await expect(lastHeader(page)).toContainText("Mira")
})

test("hundreds of cards stay searchable and reachable by keyboard on a phone, picking the persona", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await chatWith(["Mira"])
  const cardCount = await admin((api) =>
    Effect.gen(function* () {
      for (let index = 0; index < 240; index++) {
        const name = `Visitor ${String(index).padStart(3, "0")}`
        yield* api.CreateCard({ label: name, name })
      }
      return (yield* api.ListCards()).length
    })
  )
  // The persona is picked from the library; the speaker only from the chat's cast.
  await page.goto(`${server().url}/library`)
  await page.getByRole("link", { name: "Start a chat with Mira" }).first().click()
  // Who you play is the Cast tab's, as in a saved chat.
  await openPanel(page, "Cast")
  await page.getByRole("button", { name: /^Playing as / }).click()
  await page.getByRole("tab", { name: "All cards" }).click()
  const search = page.getByRole("combobox", { name: "Find a card to play as" })
  await expect(search).toBeFocused()
  // The library, less the card the chat starts with.
  await expect(page.getByRole("option").first()).toHaveAttribute("aria-setsize", String(cardCount - 1))
  expect(await page.getByRole("option").count()).toBeLessThan(30)
  // The file shares a library with other scenarios; isolate the rows this test created.
  await search.fill("Visitor")
  await expect(page.getByRole("option").first()).toHaveAttribute("aria-setsize", "240")
  await search.press("End")
  await search.press("ArrowUp")
  await expect(page.getByRole("option", { name: "Visitor 238" })).toHaveAttribute("aria-selected", "true")
  await expect(search).toBeInViewport()
  await search.fill("239")
  await expect(page.getByRole("option")).toHaveCount(1)
  await search.press("Enter")
  await expect(page.getByRole("button", { name: /^Playing as Visitor 239/ })).toBeVisible()
})

test("a phone names the Generate action in full on its icon and keeps an empty input compact", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const chatId = await chatWith(["Mira", "Captain Rhee"])
  await page.goto(`${server().url}/chats/${chatId}`)
  await speakerChip(page).click()
  await page.getByRole("combobox", { name: "Find someone to speak as, or a persona", exact: true }).fill("rhee")
  await page.keyboard.press("Enter")
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Captain Rhee/)
  // An icon on a phone, its full name its label (and tooltip), never a cut-off "Generate Capt…".
  const write = page.getByRole("button", { name: "Generate Captain Rhee", exact: true })
  await expect(write).toBeEnabled()
  await expect(write).toBeInViewport({ ratio: 1 })
  expect((await write.boundingBox())!.width).toBeLessThan(45)
  expect((await composer(page).boundingBox())!.height).toBeLessThan(45)
})

test("a phone's strip keeps each chip's whole text and fades where more chips are past the edge", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const long = "Bartholomew Featherstonehaugh-Underwood"
  const chatId = await chatWith(["Mira", long])
  await page.goto(`${server().url}/chats/${chatId}`)
  await pickReply(page, long)
  await expect(nextChip(page)).toHaveAccessibleName(nextName(long))
  const strip = nextReply(page)
  // No chip's text is cut to an ellipsis: the row scrolls instead, and says so at its edges.
  for (const chip of await strip.getByRole("button").all())
    expect(
      await chip.evaluate((node) => [...node.querySelectorAll("span")].every((s) => s.scrollWidth <= s.clientWidth))
    ).toBe(true)
  // Picking scrolled the row to the chip; from its start, more chips are past the end only.
  await strip.evaluate((node) => node.scrollTo({ left: 0 }))
  await expect(strip).toHaveAttribute("data-more-after", "true")
  await expect(strip).not.toHaveAttribute("data-more-before")
  const now = strip.getByRole("button", { name: `${long} replies now`, exact: true })
  await now.scrollIntoViewIfNeeded()
  await expect(now).toBeInViewport({ ratio: 1 })
  await expect(strip).toHaveAttribute("data-more-before", "true")
})

test("Auto's pick follows the branch tip, beyond the loaded window", async ({ page }) => {
  const chatId = await chatWith(["Mira", "Tobin", "Wren"])
  const firstSlot = await admin((api) =>
    Effect.gen(function* () {
      const cards = yield* api.ListCards()
      const entity = (name: string) => cards.find((card) => card.name === name)!.entityId
      let parent = null as import("@rp/shared/chat.ts").SlotId | null
      let first = parent
      for (let index = 0; index < 82; index++) {
        const sent = yield* api.SendMessage({
          chatId,
          parentSlotId: parent,
          branch: false,
          content: index === 81 ? "Turn 81: Wren, are you awake?" : `Turn ${index}: the room is quiet.`,
          speakerEntityId: entity(index === 0 ? "Mira" : index === 1 ? "Tobin" : "Ana")
        })
        if (sent._tag === "Posted") {
          parent = sent.entry.slotId
          first ??= parent
        }
      }
      return first
    })
  )
  // An old-message deep link opens around Mira and Tobin; the pick still reads the tip, which
  // names Wren (who never passes the roll). Read from the turns shown, it would be Mira.
  await page.goto(`${server().url}/chats/${chatId}?slot=${firstSlot}`)
  await expect(nextChip(page)).toHaveAccessibleName(nextName("Wren"))
  await expect(page.getByRole("button", { name: "Wren replies", exact: true })).toBeEnabled()
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(nextChip(page)).toHaveAccessibleName(nextName("Wren"))
})

test("typing stays available while the saved speaker is loading; sending waits for it", async ({ page }) => {
  const chatId = await chatWith(["Mira"])
  let waiting = false
  let release: (() => void) | null = null
  await page.routeWebSocket("**/rpc", (socket) => {
    const upstream = socket.connectToServer()
    const held: Array<string | Buffer> = []
    let resumed = false
    release = () => {
      resumed = true
      for (const message of held) upstream.send(message)
    }
    socket.onMessage((message) => {
      if (!resumed && String(message).includes('"tag":"GetComposerChoice"')) {
        waiting = true
        held.push(message)
      } else upstream.send(message)
    })
    upstream.onMessage((message) => socket.send(message))
  })
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect.poll(() => waiting).toBe(true)
  await expect(composer(page)).toBeEditable()
  await composer(page).fill("Kept while the speaker loads.")
  const send = page.getByRole("button", { name: "Send as Ana" })
  await expect(send).toBeDisabled()
  release!()
  await expect(send).toBeEnabled()
  await expect(composer(page)).toHaveValue("Kept while the speaker loads.")
  await send.click()
  await expect(page.getByRole("article", { name: "Your message", exact: true }).last()).toContainText(
    "Kept while the speaker loads."
  )
})

test("empty Enter requests the visible empty-box reply without adding human text", async ({ page }) => {
  const chatId = await chatWith(["Mira"])
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(page.getByRole("button", { name: "Mira replies", exact: true })).toBeEnabled()
  await composer(page).press("Enter")
  await expect(page.getByRole("article")).toHaveCount(1)
  await expect(lastHeader(page)).toContainText("Mira")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  await expect(composer(page)).toHaveValue("")
})

// Naming from the surfaces the user has open, including another tab and the bin;
// deleting a named branch must navigate through a surviving sibling, then Undo restores it.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({
  ...withAdmin,
  DB_WORKERS: "bundle",
  FAKE_GENERATOR_TPS: "300",
  FAKE_GENERATOR_TOKENS: "60"
})
type Api = Parameters<Parameters<typeof asUser>[3]>[0]
const admin = <A>(use: (api: Api) => Effect.Effect<A, unknown>) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const rename = async (page: Page, title: string, name: string) => {
  await page.getByRole("heading", { level: 1 }).getByRole("button").click()
  // A chat on its own is renamed in place; one of a group's several chats asks in a dialog.
  const dialog = page.getByRole("dialog", { name: title })
  const inPlace = page.getByRole("textbox", { name: "Chat name", exact: true })
  await expect(dialog.or(inPlace)).toBeVisible()
  if (await inPlace.isVisible()) {
    await inPlace.fill(name)
    await inPlace.press("Enter")
    await expect(inPlace).toHaveCount(0)
    return
  }
  await dialog.getByLabel("Name", { exact: true }).fill(name)
  await dialog.getByRole("button", { name: "Rename", exact: true }).click()
  await expect(dialog).toHaveCount(0)
}
const importCard = async (page: Page, name: string) => {
  const response = await page.request.post(`${server().url}/library/import?name=${name}.json`, {
    data: Buffer.from(
      JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name,
          first_mes: `${name} greets {{user}} at {{time}}.`,
          alternate_greetings: [`${name} waves at {{user}}.`]
        }
      })
    ),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

for (const width of [1440, 390]) {
  test(`chat and group names, four greetings and the bin at ${width}`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const names = ["Mira", "Tobin", "Wren", "Lark"].map((name) => `${name}${width}`)
    for (const name of names) await importCard(page, name)
    const ids = await admin((api) =>
      Effect.map(api.ListCards(), (cards) => names.map((name) => cards.find((c) => c.name === name)!.entityId))
    )
    const started = await admin((api) =>
      Effect.gen(function* () {
        const start = (cards = ids, title = "The Lantern Inn") =>
          api.StartChat({
            cards,
            persona: null,
            greeting: 0,
            title,
            first: { _tag: "Send", content: "A beginning.", speakerEntityId: null }
          })
        const single = yield* start([ids[0]!], "Single")
        const first = yield* start()
        const second = yield* start()
        return { single: single.chat.id, first: first.chat.id, second: second.chat.id }
      })
    )
    await page.goto(`${server().url}/chats/${started.single}`)
    const other = await context.newPage()
    await other.goto(page.url())
    await rename(page, "Rename chat", `A renamed chat ${width}`)
    await expect(other.getByRole("heading", { level: 1 })).toHaveText(`A renamed chat ${width}`)
    await other.close()
    await page.goto(`${server().url}/groups/${started.first}`)
    await page.getByRole("button", { name: "Rename group" }).click()
    const groupDialog = page.getByRole("dialog", { name: "Rename group" })
    await groupDialog.getByLabel("Name", { exact: true }).fill(`Winter inn ${width}`)
    await groupDialog.getByRole("button", { name: "Rename", exact: true }).click()
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Winter inn ${width}`)
    await expect(page.getByRole("heading", { name: "Chats (2)" })).toBeVisible()
    await page.goto(`${server().url}/`)
    // The home page lists groups by their chats' forks under Groups (the shell, 8e20190).
    await page.getByRole("main").getByRole("group", { name: "Show" }).getByRole("button", { name: "Groups" }).click()
    await expect(
      page.getByRole("main").getByRole("link", { name: `Open chat Winter inn ${width}`, exact: true })
    ).toHaveCount(2)
    await page.goto(`${server().url}/chats/${started.second}`)
    await page.getByRole("heading", { level: 1 }).getByRole("button").click()
    const dialog = page.getByRole("dialog", { name: "Rename chat" })
    await expect(dialog.getByText(/it leaves/)).toContainText("shows under its new name")
    await dialog.getByLabel("Name", { exact: true }).fill(`Side story ${width}`)
    await dialog.getByRole("button", { name: "Rename", exact: true }).click()
    await page.goto(`${server().url}/groups/${started.first}/new`)
    const greetings = page.getByRole("article", { name: /^Greeting from / })
    await expect(greetings).toHaveCount(4)
    // Select the alternate of each member explicitly, and keep the previews after sending.
    for (let i = 0; i < names.length; i++) {
      const next = greetings.nth(i).getByRole("button", { name: `Next greeting from ${names[i]}` })
      if (await next.isEnabled()) await next.click()
    }
    const previews = await greetings.locator(".markdown").allTextContents()
    await page.getByLabel("Message", { exact: true }).fill("Hello everyone.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(page).toHaveURL(/\/chats\/[^/?]+(?:\?.*)?$/)
    const replies = page.getByRole("article", { name: "Reply" })
    // Four greetings, the message and the reply to it. A phone mounts only the messages in view
    // and two beyond (clientperf): the reply is read at the end, the greetings from the top.
    await expect(replies.last()).toContainText("#6")
    await page.getByTestId("messages").evaluate((list) => list.scrollTo({ top: 0 }))
    for (let i = 0; i < previews.length; i++) await expect(replies.nth(i)).toContainText(previews[i]!)
    await page.goto(`${server().url}/chats`)
    const row = page
      .getByRole("main")
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: /A renamed chat/ }) })
    await row.hover()
    await row.getByRole("button", { name: /Delete/ }).click()
    await expect(page.getByText(`A renamed chat ${width} moved to the bin.`, { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Open the bin" }).click()
    await expect(page.getByRole("main").getByText(`A renamed chat ${width}`, { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  })

  test(`name, switch, delete and undo a branch at ${width}`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const chatId = await admin((api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateChat({ title: "Forks" })
        const root = yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Root" })
        if (root._tag !== "Posted") throw new Error("expected a posted message")
        for (const content of ["The tavern", "The road"])
          yield* api.SendMessage({ chatId: chat.id, parentSlotId: root.entry.slotId, branch: true, content })
        return chat.id
      })
    )
    await page.goto(`${server().url}/chats/${chatId}`)
    const other = await context.newPage()
    await other.goto(page.url())
    await other.getByRole("button", { name: /switch branch/ }).click()
    await other.keyboard.press("Escape")
    const branches = page.getByRole("button", { name: /switch branch/ })
    const list = page.getByRole("list", { name: "Branches" })
    await branches.click()
    await list.getByRole("button", { name: /^Rename Split .+ at #1$/ }).click()
    await list.getByRole("textbox", { name: /^Name of branch Split .+ at #1$/ }).fill("Road trip")
    await list.getByRole("button", { name: "Save the name", exact: true }).click()
    await page.keyboard.press("Escape")
    await expect(branches).toHaveAccessibleName(/Road trip/)
    await expect(other.getByRole("button", { name: /switch branch/ })).toHaveAccessibleName(/Road trip/)
    await other.close()
    await branches.click()
    await list.getByRole("link", { name: /^Original/ }).click()
    await expect(page.getByTestId("messages").getByText("The tavern", { exact: true })).toBeVisible()
    await branches.click()
    await list.getByRole("link", { name: /^Road trip/ }).click()
    await expect(page.getByTestId("messages").getByText("The road", { exact: true })).toBeVisible()
    await branches.click()
    await list.getByRole("button", { name: "Delete Road trip", exact: true }).click()
    await expect(page.getByTestId("messages").getByText("The tavern", { exact: true })).toBeVisible()
    await expect(page.getByTestId("messages").getByText("The road", { exact: true })).toHaveCount(0)
    await page.getByRole("button", { name: "Undo", exact: true }).click()
    await expect(branches).toBeVisible()
    await branches.click()
    await list.getByRole("link", { name: /^Road trip/ }).click()
    await expect(page.getByTestId("messages").getByText("The road", { exact: true })).toBeVisible()
    await branches.click()
    await list.getByRole("button", { name: "Rename Road trip", exact: true }).click()
    await list.getByRole("textbox", { name: "Name of branch Road trip" }).fill("")
    await list.getByRole("button", { name: "Save the name", exact: true }).click()
    await page.keyboard.press("Escape")
    await expect(branches).toHaveAccessibleName(/Branch: Split .+ at #1, /)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await expect(page.getByRole("alert")).toHaveCount(0)
  })
}

test("deleting a named branch from the middle of a long chat follows the surviving tip", async ({ page }) => {
  test.setTimeout(120_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chatId = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "A long fork" })
      const root = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "Common root"
      })
      if (root._tag !== "Posted") throw new Error("expected a posted message")
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: root.entry.slotId,
        branch: false,
        content: "Surviving tip"
      })
      // The long road is a fork made at the root, chatted in last, so the chat opens on it.
      let tip = root.entry.slotId
      for (let i = 0; i < 90; i++) {
        const sent = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: tip,
          branch: i === 0,
          content: `Long path ${i}`
        })
        if (sent._tag !== "Posted") throw new Error("expected a posted message")
        tip = sent.entry.slotId
        if (i === 0) yield* api.NameFork({ forkId: sent.entry.startsForkId!, name: "Long road" })
      }
      return chat.id
    })
  )
  await page.goto(`${server().url}/chats/${chatId}`)
  const branches = page.getByRole("button", { name: /switch branch/ })
  const list = page.getByRole("list", { name: "Branches" })
  await branches.click()
  await page.getByRole("button", { name: "Go to where this branch starts" }).click()
  await expect(page).toHaveURL(/[?&]slot=/)
  await branches.click()
  await list.getByRole("button", { name: "Delete Long road", exact: true }).click()
  // On the surviving branch, with no message to go to; the pane's own view params (Messages or
  // Summaries, the coverage rail) stay as they were.
  await expect
    .poll(() => {
      const url = new URL(page.url())
      return [url.pathname, [...url.searchParams.keys()].filter((key) => key !== "timeline" && key !== "rail")]
    })
    .toEqual([`/chats/${chatId}`, ["fork"]])
  await expect(page.getByTestId("messages").getByText("Surviving tip", { exact: true })).toBeVisible()
  await expect(branches).toBeVisible()
  await expect(branches).toBeDisabled()
  await expect(branches).toHaveAccessibleName(/Branch: Original, 1 of 1/)
  await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
  await page.getByRole("button", { name: "Undo", exact: true }).click()
  await branches.click()
  // A branch opens at its last message.
  await list.getByRole("link", { name: /^Long road/ }).click()
  await expect(page.getByTestId("messages").getByText("Long path 89", { exact: true })).toBeVisible()
})

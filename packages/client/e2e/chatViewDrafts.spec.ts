// What a message keeps whatever happens around it: the text typed into its editor across a
// reload, its version arrows on every reply, its speaker and side when the version it
// started with is deleted, the text streamed so far when it's copied, and, on a phone, the
// start of why it isn't sent when a tap reveals its actions.
import { expect, type Page, test } from "@playwright/test"
import type { ChatId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { card, header, jsonl, message } from "../../server/test/support/stFolder.ts"
import { messageMenu, showActions } from "./support/message.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "60", FAKE_GENERATOR_TOKENS: "600" })

const create = () => asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.CreateChat({ title: "Drafts" }))

const open = async (page: Page, chatId: ChatId, search = "") => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}${search}`)
}

/** Sends a message and stops its reply before it's done: the chat's last reply, its own slot. */
const stoppedReply = async (page: Page, text: string) => {
  await page.getByLabel("Message", { exact: true }).fill(text)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByText("generating", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Stop", exact: true }).last().click()
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0)
  const slot = await page.getByRole("article", { name: "Reply", exact: true }).last().getAttribute("data-slot")
  return page.locator(`article[data-slot="${slot}"]`)
}

test("the text of a version being written, and of an edit, survives a reload and opens again", async ({ page }) => {
  const chat = await create()
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "The original turn." })
  )
  await open(page, chat.id)
  const row = page.locator("article[data-slot]").first()
  await messageMenu(row, "Write your own version")
  await row.getByLabel("Your version", { exact: true }).fill("An irreplaceable draft assembled from several swipes.")
  await page.waitForTimeout(1000)
  await page.reload()
  // The editor is open again where it was, with its text.
  await expect(row.getByLabel("Your version", { exact: true })).toHaveValue(
    "An irreplaceable draft assembled from several swipes."
  )
  await row.getByRole("button", { name: "Add as a new version" }).click()
  await expect(row.locator(".markdown")).toHaveText("An irreplaceable draft assembled from several swipes.")
  await page.reload()
  await expect(row.locator(".markdown")).toHaveText("An irreplaceable draft assembled from several swipes.")
  await expect(row.getByLabel("Your version", { exact: true })).toHaveCount(0)

  await showActions(row)
  await row.getByRole("button", { name: "Edit", exact: true }).click()
  await row.getByLabel("Message text", { exact: true }).fill("An edit half done.")
  await page.waitForTimeout(1000)
  await page.reload()
  await expect(row.getByLabel("Message text", { exact: true })).toHaveValue("An edit half done.")
  // Cancelling closes it for good: its text goes to the recovered texts, not back into the box.
  await row.getByRole("button", { name: "Cancel" }).click()
  await expect(row.getByLabel("Message text", { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(row.locator(".markdown")).toHaveText("An irreplaceable draft assembled from several swipes.")
  await expect(row.getByLabel("Message text", { exact: true })).toHaveCount(0)
})

test("an older reply keeps its version arrows with one version", async ({ page }) => {
  const chat = await create()
  await open(page, chat.id)
  const first = await stoppedReply(page, "First turn.")
  await page.getByLabel("Message", { exact: true }).fill("Next turn.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("article", { name: "Reply", exact: true })).toHaveCount(2)
  const versions = first.getByRole("group", { name: "Versions", exact: true })
  await expect(versions).toBeVisible()
  await expect(versions.getByRole("button", { name: "Generate another version" })).toBeVisible()
})

test("copy text copies the text already shown while a version is streaming", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  const chat = await create()
  await open(page, chat.id)
  await page.getByLabel("Message", { exact: true }).fill("A streaming reply.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  const reply = page.getByRole("article", { name: "Reply", exact: true }).last()
  await expect(reply.locator(".markdown")).toBeVisible()
  await page.waitForTimeout(500)
  await messageMenu(reply, "Copy text")
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied.length).toBeGreaterThan(0)
  // The text's source (Markdown): its first words are the first the message shows.
  const words = (text: string) => (text.match(/[A-Za-z]+/g) ?? []).join(" ")
  expect(words(await reply.locator(".markdown").innerText())).toContain(words(copied).split(" ").slice(0, 4).join(" "))
})

test("a reply written by hand keeps its speaker and Regenerate after the original is deleted", async ({ page }) => {
  const chat = await create()
  await open(page, chat.id)
  const row = await stoppedReply(page, "First turn.")
  await messageMenu(row, "Write your own version")
  await row.getByLabel("Your version", { exact: true }).fill("My assembled reply.")
  await row.getByRole("button", { name: "Add as a new version" }).click()
  await row.getByRole("button", { name: "Previous version", exact: true }).click()
  await showActions(row)
  await row.getByRole("button", { name: "Delete version", exact: true }).click()
  await expect(row.locator(".markdown")).toHaveText("My assembled reply.")
  await expect(row).toHaveAttribute("aria-label", "Reply")
  await showActions(row)
  await expect(row.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible()
})

test("on a phone, a tap on a long message out of the context shows the start of why", async ({ page }) => {
  // A synthetic ST import whose card takes the default preset's whole budget: no history is sent.
  const { importId } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      yield* api.SetGenerationDefaults({ defaults: { model: null, preset: null } })
      return yield* api.StartStImport({ unsupported: [] })
    })
  )
  const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  const upload = async (path: string, body: Uint8Array) => {
    const response = await fetch(`${server().url}/st-import/file?${new URLSearchParams({ import: importId, path })}`, {
      method: "POST",
      headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
      body: new Uint8Array(body)
    })
    expect(response.status).toBe(200)
  }
  await upload("characters/Mira.png", card("Mira", "Hello.", {}, { description: "x".repeat(14_000) }))
  const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} of a long turn. ${"b".repeat(80)}`).join("\n\n")
  await upload(
    "chats/Mira/Long turns.jsonl",
    jsonl([
      header({}),
      ...Array.from({ length: 12 }, (_, i) =>
        message({ name: i % 2 ? "Sam" : "Mira", user: i % 2 === 1, minute: i, mes: i === 6 ? long : `Turn ${i}.` })
      )
    ])
  )
  const { chatId, slotId } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = (yield* api.ListChats({ limit: 10, before: null })).find((c) => c.title === "Long turns")!
      const { entries } = yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 100
      })
      return { chatId: chat.id, slotId: entries[6]!.slotId }
    })
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page, chatId, `?slot=${slotId}`)
  const row = page.locator(`article[data-slot="${slotId}"]`)
  await expect(row).toHaveAttribute("data-out-of-context", "true")
  await row.locator(".markdown").click({ position: { x: 20, y: 20 } })
  await expect(row.getByRole("toolbar", { name: "Message actions" })).toBeVisible()
  const reason = row.getByText(/^Not sent to the model: the history sent starts at #13/)
  await expect(reason).toBeVisible()
  await page.waitForTimeout(600)
  const box = (await reason.boundingBox())!
  const list = (await page.getByTestId("messages").boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(list.y)
  expect(box.y + box.height).toBeLessThanOrEqual(list.y + list.height)
})

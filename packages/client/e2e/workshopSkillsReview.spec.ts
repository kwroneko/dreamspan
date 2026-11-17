// Review of the card editor's Skills section and the workshop start card (review-wsb2): reorder
// by the handle with the keyboard and by dragging, Undo as for any card field, a reference that
// doesn't claim a skill is installed, and start choices that live in the URL: Back restores the
// previous one, and an id the library doesn't have is dropped rather than sent. Made-up cards only.
import { expect, type Page, test } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { saveRevision } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(150_000)

const own = (name: string) => ({
  name,
  description: `What ${name} is for.`,
  instructions: `How ${name} is done.`,
  tools: ["read_card"]
})

const importCard = async (page: Page, name: string, skills: ReadonlyArray<unknown>) => {
  const data = {
    name,
    description: `${name} keeps the tide tables.`,
    personality: "",
    scenario: "",
    first_mes: "",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: [],
    creator: "Synthetic",
    character_version: "1.0",
    extensions: { rp_harness: { skills, kept: "other data" } }
  }
  const body = Buffer.from(JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data }))
  const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
    data: body,
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
  return (await response.json()).library.ref as { id: RefId; entityId: EntityId }
}

const savedSkills = async (refId: RefId) => {
  const opened = await admin((api) => api.OpenEditor({ refId }))
  const ours = (opened.doc as { extensions?: { rp_harness?: { skills?: Array<{ name?: string; use?: string }> } } })
    .extensions?.rp_harness
  return { names: ours?.skills?.map((s) => s.name ?? `use:${s.use}`), ours }
}

for (const width of [1440, 390])
  test(`skills reorder by keyboard and drag, and many long skills fit, at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const ref = await importCard(page, `Tide keeper ${width}`, [
      own("alpha"),
      own("bravo"),
      { use: "no-such-skill" },
      own("charlie")
    ])
    await page.goto(`${server().url}/library/${ref.id}`)
    await page.getByRole("tab", { name: "Extra", exact: true }).click()
    const list = page.getByRole("list", { name: "Skills", exact: true })
    const names = () => list.getByRole("listitem").locator(".font-mono").allTextContents()
    await expect.poll(names).toEqual(["alpha", "bravo", "no-such-skill", "charlie"])
    // A reference says what it does without claiming the skill exists.
    await expect(list.getByRole("listitem").nth(2)).toContainText("if there is one")
    await expect(list.getByRole("listitem").nth(2)).not.toContainText("installed skill with this name.")

    // Keyboard: the handle is a button; the arrows move its item and it keeps the focus.
    const handle = page.getByRole("button", { name: "Move alpha", exact: true })
    await handle.focus()
    await page.keyboard.press("ArrowDown")
    await expect.poll(names).toEqual(["bravo", "alpha", "no-such-skill", "charlie"])
    await page.keyboard.press("ArrowDown")
    await expect.poll(names).toEqual(["bravo", "no-such-skill", "alpha", "charlie"])
    await page.keyboard.press("ArrowUp")
    await expect.poll(names).toEqual(["bravo", "alpha", "no-such-skill", "charlie"])

    // Dragging the handle (a mouse here; the list takes pointer events of any kind).
    const from = (await page.getByRole("button", { name: "Move bravo", exact: true }).boundingBox())!
    const last = (await list.getByRole("listitem").nth(3).boundingBox())!
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2, last.y + last.height / 2, { steps: 8 })
    await page.mouse.move(from.x + from.width / 2, last.y + last.height - 2, { steps: 4 })
    await page.mouse.up()
    await expect.poll(names).toEqual(["alpha", "no-such-skill", "charlie", "bravo"])

    // Saved as a revision like any card field, the extension's other data kept.
    await saveRevision(page)
    await expect
      .poll(async () => (await savedSkills(ref.id)).names)
      .toEqual(["alpha", "use:no-such-skill", "charlie", "bravo"])
    expect(((await savedSkills(ref.id)).ours as { kept?: string }).kept).toBe("other data")

    // The row's menu moves too, and Remove takes one out.
    await list.getByRole("listitem").nth(3).click({ button: "right" })
    await page.getByRole("menuitem", { name: /^Move up/ }).click()
    await expect.poll(names).toEqual(["alpha", "no-such-skill", "bravo", "charlie"])

    // Sixteen skills with the longest text allowed, one past the limit: the list stays in the page.
    const many = await importCard(
      page,
      `Crowded keeper ${width}`,
      Array.from({ length: 17 }, (_, i) => ({
        name: `skill-${String(i).padStart(2, "0")}-${"n".repeat(36)}`,
        description: "d".repeat(300),
        instructions: "word ".repeat(1600),
        tools: Array.from({ length: 64 }, (_, t) => `tool_${t}`)
      }))
    )
    await page.goto(`${server().url}/library/${many.id}`)
    await page.getByRole("tab", { name: "Extra", exact: true }).click()
    await expect(list.getByRole("listitem")).toHaveCount(17)
    await expect(list.getByRole("listitem").nth(16)).toContainText("Only the first 16 skills are used.")
    await expect(list.getByRole("listitem").nth(15)).not.toContainText("Only the first")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await list.getByRole("listitem").nth(16).scrollIntoViewIfNeeded()
    await expectLayout(page, info, `wsskills-review-many-${width}`)
    await page.getByRole("button", { name: /^Edit skill-00/ }).click()
    const dialog = page.getByRole("dialog", { name: /^Edit skill-00/ })
    await expect(dialog.getByLabel("Instructions", { exact: true })).toHaveValue("word ".repeat(1600))
    await expectLayout(page, info, `wsskills-review-long-dialog-${width}`)
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(dialog).toBeHidden()
  })

test("start choices live in the URL: Back restores, a second tab is independent, unknown ids are dropped", async ({
  page,
  context
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const ref = await importCard(page, "Signal keeper", [own("alpha")])
  // The defaults exist once a workshop was made.
  await admin((api) => api.CreateWorkshop({}))
  const defaults = await admin((api) => api.GetWorkshopDefaults({}))

  await page.goto(`${server().url}/chats`)
  const assistant = page.getByRole("button", { name: /^Assistant: / })
  await expect(assistant).toHaveAccessibleName("Assistant: Assistant")
  await assistant.click()
  await page.getByRole("radio", { name: /Signal keeper/ }).click()
  await expect(page).toHaveURL(new RegExp(`workshopCard=${ref.entityId}`))
  await expect(assistant).toHaveAccessibleName("Assistant: Signal keeper")

  // A second tab at the plain address shows the default: the choice belongs to the first tab's URL.
  const second = await context.newPage()
  await second.goto(`${server().url}/chats`)
  await expect(second.getByRole("button", { name: /^Assistant: / })).toHaveAccessibleName("Assistant: Assistant")
  await second.close()

  // Back undoes the choice.
  await page.goBack()
  await expect(page).not.toHaveURL(/workshopCard=/)
  await expect(assistant).toHaveAccessibleName("Assistant: Assistant")

  // Ids the library doesn't have (deleted, or another account's): dropped, never sent.
  await page.goto(`${server().url}/chats?workshopCard=01HZZZZZZZZZZZZZZZZZZZZZZZ&workshopPersona=${ref.entityId}`)
  await expect(page).not.toHaveURL(/workshopCard=|workshopPersona=/)
  await expect(page.getByRole("button", { name: /^Assistant: / })).toHaveAccessibleName("Assistant: Assistant")
  await page.getByRole("button", { name: "New workshop", exact: true }).click()
  // It opens the workshop not made yet, with these choices; its first message makes it.
  await expect(page).toHaveURL(/\/new\/workshop/)
  await page.getByLabel("Message", { exact: true }).fill("Hello.")
  await page.getByRole("button", { name: /^Send/ }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+/)
  const chatId = new URL(page.url()).pathname.split("/").at(-1)!
  const cast = await admin((api) => api.GetCast({ chatId: chatId as never, slotId: null }))
  expect(cast.participants).toContain(defaults.card)
  expect(cast.participants).not.toContain(ref.entityId)
  expect(await admin((api) => api.GetWorkshopDefaults({}))).toEqual(defaults)
})

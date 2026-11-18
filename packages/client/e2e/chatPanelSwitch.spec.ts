// Moving from one chat to another with a character's tab open: the panel follows the chat it's
// in. A card tab names one chat's character; carried to another chat (by a sidebar pick, or by
// the tab this browser remembers) the panel opens at This chat, never at the previous chat's card
// with its edit controls (the UI audit's §8). Every card here is made up.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { EntityId } from "@rp/shared/chat.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(120_000)

const importCard = async (page: Page, data: Record<string, unknown>) => {
  const body = Buffer.from(JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data }))
  const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
    data: body,
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

const card = (name: string) => ({
  name,
  description: `${name} mends nets on the quay and hums while doing it.`,
  personality: "Patient.",
  scenario: "",
  first_mes: `${name} looks up. "Oh, it's you."`,
  mes_example: ""
})

let first = { chat: "", card: "" }
let second = { chat: "", card: "" }
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const name of ["Odalys Fenwick", "Marguerite Quill"]) await importCard(page, card(name))
  await page.close()
  const refs = await admin((api) => api.ListLibrary({ kind: "card" }))
  const id = (name: string) => refs.find((ref) => ref.label === name)!.entityId as EntityId
  const started = await admin((api) =>
    Effect.all([
      api.StartChat({
        cards: [id("Odalys Fenwick")],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Hello, Odalys.", speakerEntityId: null }
      }),
      api.StartChat({
        cards: [id("Marguerite Quill")],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Hello, Marguerite.", speakerEntityId: null }
      })
    ])
  )
  first = { chat: started[0].chat.id, card: id("Odalys Fenwick") }
  second = { chat: started[1].chat.id, card: id("Marguerite Quill") }
})

/** The panel shows the second chat's own tabs and nothing of the first's card. */
const showsSecond = async (page: Page) => {
  const panel = page.getByRole("complementary", { name: "Chat panel" })
  await expect(panel.getByRole("tab", { name: "This chat", exact: true })).toHaveAttribute("aria-selected", "true", {
    timeout: 30_000
  })
  await expect(panel.getByRole("tab", { name: "Marguerite Quill", exact: true })).toBeVisible()
  await expect(panel.getByText("Odalys Fenwick")).toHaveCount(0)
  await expect(panel.getByRole("tab", { name: "Character", exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/chats/${second.chat}\\?(.*&)?panel=chat(&|$)`))
  // Its own character's tab edits its own card.
  await panel.getByRole("tab", { name: "Marguerite Quill", exact: true }).click()
  await expect(panel.getByRole("heading", { name: "Marguerite Quill", exact: true })).toBeVisible()
  await expect(panel.getByRole("textbox", { name: "Description", exact: true })).toContainText(
    "Marguerite Quill mends nets"
  )
}

test("a sidebar pick of another chat leaves the previous chat's character", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${first.chat}?panel=card:${first.card}`)
  const panel = page.getByRole("complementary", { name: "Chat panel" })
  await expect(panel.getByRole("heading", { name: "Odalys Fenwick", exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole("link", { name: /^Open chat Marguerite Quill/ }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${second.chat}`))
  await showsSecond(page)
})

test("the tab this browser remembers leaves the previous chat's character", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${first.chat}?panel=card:${first.card}`)
  const panel = page.getByRole("complementary", { name: "Chat panel" })
  await expect(panel.getByRole("heading", { name: "Odalys Fenwick", exact: true })).toBeVisible({ timeout: 30_000 })
  // Chosen, so this browser tab remembers it; then Home, with no tab in the URL, and from there
  // the other chat.
  await page.getByRole("tab", { name: "Cast", exact: true }).click()
  await page.getByRole("tab", { name: "Odalys Fenwick", exact: true }).click()
  await expect(panel.getByRole("heading", { name: "Odalys Fenwick", exact: true })).toBeVisible()
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Home" }).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe("/")
  await page.getByRole("link", { name: /^Open chat Marguerite Quill/ }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${second.chat}`))
  await showsSecond(page)
})

test("a link carrying another chat's card tab leaves that card", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${second.chat}?panel=card:${first.card}`)
  await showsSecond(page)
})

// Observe the production build's committed list props through React's DevTools seam.
// Source-only hook tests miss React Compiler adding a mutable search dependency.
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`panel switches retain the timeline callback: ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript(() => {
        interface Fiber {
          memoizedProps?: { flashes?: unknown; session?: unknown; onBranch?: unknown }
          alternate?: Fiber
          child?: Fiber
          sibling?: Fiber
        }
        const windowWithHook = window as unknown as {
          __panelCallbacks: { armed: boolean; seen: number; changed: number }
          __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown
        }
        const counts = { armed: false, seen: 0, changed: 0 }
        windowWithHook.__panelCallbacks = counts
        windowWithHook.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
          supportsFiber: true,
          inject: () => 1,
          onCommitFiberUnmount: () => {},
          onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
            const visit = (fiber: Fiber | undefined) => {
              if (!fiber) return
              const props = fiber.memoizedProps
              const before = fiber.alternate?.memoizedProps
              if (props?.flashes && props.session && props.onBranch) {
                counts.seen++
                if (counts.armed && before && before.onBranch !== props.onBranch) counts.changed++
              }
              visit(fiber.child)
              visit(fiber.sibling)
            }
            visit(root.current)
          }
        }
      })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${first.chat}?panel=chat`)
      await expect(page.getByRole("tabpanel", { name: "This chat", exact: true })).toBeVisible()
      await page.waitForFunction(
        () => (window as unknown as { __panelCallbacks: { seen: number } }).__panelCallbacks.seen > 0
      )
      await page.evaluate(() => {
        const counts = (window as unknown as { __panelCallbacks: { armed: boolean; changed: number } }).__panelCallbacks
        counts.armed = true
        counts.changed = 0
      })
      for (const name of ["Model", "Prompt preset", "Lorebooks", "Summaries", "Notes", "Cast", "This chat"])
        await openPanel(page, name)
      const changed = await page.evaluate(
        () => (window as unknown as { __panelCallbacks: { changed: number } }).__panelCallbacks.changed
      )
      expect(changed, "a panel choice must not replace the timeline's branch callback").toBe(0)
    })

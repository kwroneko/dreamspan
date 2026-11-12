// Review regressions: a page's results stay fixed while replies arrive; a result in the
// middle of a long virtualized timeline opens at the right message, including after reload.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { newCardDoc } from "@rp/shared/editing.ts"
import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let cookie = ""
const run = <A>(f: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), cookie, f)
let deep = { chat: "", fork: "", slot: "" }
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  const chat = await run((api) => api.CreateChat({ title: "Deep sea" }))
  const n = "WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<1499)"
  await Effect.runPromise(
    fixtureSql(server().dataDir, [
      {
        sql: `${n} INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at)
      SELECT ?||'-v'||x,?||'-s'||x,0,'complete','human',CASE WHEN x=750 THEN 'The abyssal lantern shines.' ELSE 'A long voyage '||x END,'verbatim','user_written',1,1 FROM n`,
        params: [chat.id, chat.id]
      },
      {
        sql: `${n} INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at,fork_id)
      SELECT ?||'-s'||x,?,CASE WHEN x=0 THEN NULL ELSE ?||'-s'||(x-1) END,x,?||'-v'||x,1,? FROM n`,
        params: [chat.id, chat.id, chat.id, chat.id, chat.currentForkId]
      },
      { sql: "UPDATE forks SET tip_slot_id=? WHERE id=?", params: [`${chat.id}-s1499`, chat.currentForkId] },
      { sql: "UPDATE chats SET active_leaf_slot_id=? WHERE id=?", params: [`${chat.id}-s1499`, chat.id] }
    ])
  )
  deep = { chat: chat.id, fork: chat.currentForkId!, slot: `${chat.id}-s750` }
  const owner = await run((api) => api.Whoami())
  const numbers = "WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<2004)"
  const doc = JSON.stringify({ ...newCardDoc("Mass preview"), description: "previewmass" })
  await Effect.runPromise(
    fixtureSql(server().dataDir, [
      {
        sql: `${numbers} INSERT INTO entities(id,owner_user_id,kind,created_at) SELECT 'mass-e-'||x,?,'card',1 FROM n`,
        params: [owner.id]
      },
      {
        sql: `${numbers} INSERT INTO entity_revisions(id,entity_id,doc_json,doc_hash,schema_version,origin,search_text,created_at) SELECT 'mass-v-'||x,'mass-e-'||x,?,'h',1,'user','previewmass',1 FROM n`,
        params: [doc]
      },
      {
        sql: `${numbers} INSERT INTO entity_refs(id,entity_id,head_revision_id,label,created_at,updated_at) SELECT 'mass-r-'||x,'mass-e-'||x,'mass-v-'||x,'Mass preview '||x,1,1 FROM n`
      }
    ])
  )
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`search stays paged and opens deep messages ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const chat = await run((api) => api.CreateChat({ title: `Paging ${width} ${theme}` }))
      const token = `paging${width}${theme}`
      let parent = null as string | null
      for (let i = 0; i < 45; i++) {
        const sent = await run((api) =>
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: parent as never,
            branch: false,
            content: `${token} tide${i}`,
            reply: false
          })
        )
        if (sent._tag !== "Posted") throw new Error("unexpected queue")
        parent = sent.entry.slotId
      }
      await page.goto(`${server().url}/chats/${chat.id}?side=chats&sideIn=messages&sideQ=${token}`)
      const open = async () => {
        if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
      }
      await open()
      const panel =
        width === 390
          ? page.locator(".fixed.inset-0")
          : page.getByRole("complementary", { name: "Sidebar", exact: true })
      const hits = panel.locator("[data-message-hit]")
      await expect(hits).toHaveCount(20)
      await panel.getByRole("button", { name: "Show more", exact: true }).click()
      await expect(hits).toHaveCount(40)
      const before = await hits.allTextContents()
      await run((api) =>
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent as never,
          branch: false,
          content: `${token} new arrival`,
          reply: false
        })
      )
      // Allow the server's chat invalidation to reach the open browser.
      await page.waitForTimeout(2500)
      expect(await hits.allTextContents()).toEqual(before)
      await panel.getByRole("button", { name: "Show more", exact: true }).click()
      await expect(hits).toHaveCount(45)
      expect(new Set(await hits.evaluateAll((rows) => rows.map((row) => row.getAttribute("href")))).size).toBe(45)
      await panel.getByRole("textbox", { name: "Find in messages", exact: true }).fill("abyssal")
      await expect(hits).toHaveCount(1)
      await hits.first().click()
      const article = page.locator(`article[data-slot="${deep.slot}"]`)
      await expect(article).toBeVisible()
      await expect(article).toContainText("abyssal lantern")
      expect(new URL(page.url()).searchParams.get("fork")).toBe(deep.fork)
      expect(new URL(page.url()).searchParams.get("slot")).toBe(deep.slot)
      await expectLayout(page, info, `search-deep-${width}-${theme}`, { scope: '[data-testid="messages"]' })
      await page.reload()
      await expect(article).toBeVisible()
      await expect(article).toContainText("abyssal lantern")
    })
  }

test("changing the message query cancels its pending RPC", async ({ page }) => {
  let held: string | number | undefined
  const cancelled: Array<string | number> = []
  await page.routeWebSocket("**/rpc", (socket) => {
    const peer = socket.connectToServer()
    peer.onMessage((message) => socket.send(message))
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message)) as {
        _tag: string
        id?: string | number
        requestId?: string | number
        tag?: string
        payload?: { text?: string }
      }
      if (frame._tag === "Request" && frame.tag === "SearchMessages" && frame.payload?.text === "heldquery") {
        held = frame.id
        return
      }
      if (frame._tag === "Interrupt" && frame.requestId !== undefined) cancelled.push(frame.requestId)
      peer.send(message)
    })
  })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/?side=chats&sideIn=messages&sideQ=heldquery`)
  await expect.poll(() => held).toBeDefined()
  await page.getByRole("textbox", { name: "Find in messages", exact: true }).fill("abyssal")
  await expect.poll(() => cancelled.includes(held!)).toBe(true)
  await expect(page.locator("[data-message-hit]")).toHaveCount(1)
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`large library preview stays paged ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/library?kind=note&replace=open&find=previewmass`)
      const panel = page.getByRole("region", { name: "Search and replace across the library" })
      await panel.getByRole("textbox", { name: "Replace with", exact: true }).fill("changed")
      await panel.getByRole("button", { name: "Find", exact: true }).click()
      await expect(panel.getByText("2,005 matches in 2,005 entries of 2,005.", { exact: true })).toBeVisible({
        timeout: 30_000
      })
      await expect(panel.locator("[data-library-hit]")).toHaveCount(100)
      await panel.getByRole("button", { name: "Show more", exact: true }).click()
      await expect(panel.locator("[data-library-hit]")).toHaveCount(200)
      await expect(panel.getByRole("button", { name: "Replace 2,005", exact: true })).toBeEnabled()
      await expectLayout(page, info, `large-library-preview-${width}-${theme}`, { scope: "#library-replace" })
    })

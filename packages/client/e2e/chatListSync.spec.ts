import { logoutFromSettings } from "./support/appMenu.ts"
// The paged chat list agrees with the server after a delete or an Undo, whichever page the
// chat was on, and a pending first message survives signing out. The paged list belongs to the
// Chats page; a card's page lists its forks from the shell.
import { expect, test } from "@playwright/test"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const COUNT = 155
let card: EntityId

test.beforeAll(async () => {
  const { made, me } = await admin((api) =>
    Effect.all({ made: api.CreateCard({ label: "Paged", name: "Paged" }), me: api.Whoami() })
  )
  card = made.entityId
  const now = Date.now()
  await Effect.runPromise(
    fixtureSql(server().dataDir, [
      {
        sql: `INSERT INTO chats(id,owner_user_id,kind,status,title,created_at,last_message_at)
          WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${COUNT - 1})
          SELECT printf('paged-c-%03d',i),?,'rp','active',printf('Paged chat %03d',i),?+i,?+i FROM n`,
        params: [me.id, now, now]
      },
      {
        sql: `INSERT INTO state_events(id,chat_id,seq,key,value_json,origin,created_at)
          WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${COUNT - 1})
          SELECT printf('paged-s-%03d',i),printf('paged-c-%03d',i),0,'participant.join',json_object('entity',?),'import',? FROM n`,
        params: [card, now]
      }
    ])
  )
})

test.beforeEach(async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.setViewportSize({ width: 1440, height: 900 })
})

test("deleting a chat from a later page removes it from the list", async ({ page }) => {
  await page.goto(`${server().url}/chats`)
  const main = page.getByRole("main")
  const links = main.getByRole("list", { name: "Chats" }).getByRole("link")
  await expect(links).toHaveCount(50)
  const target = '[data-chat-id="paged-c-010"]'
  await expect(main.locator(target)).toHaveCount(0)
  for (const count of [100, 150]) {
    await main.getByRole("button", { name: "Load more", exact: true }).click()
    await expect(links).toHaveCount(count)
  }
  const row = main.getByRole("listitem").filter({ has: page.locator(target) })
  await row.hover()
  await row.getByRole("button", { name: "Delete Paged chat 010", exact: true }).click()
  await expect(main.locator(target)).toHaveCount(0)
  // The list fills back up from the next page.
  await expect(links).toHaveCount(150)
})

test("Undo shows the restored chat again in the list it was deleted from", async ({ page }) => {
  await page.goto(`${server().url}/chats`)
  const main = page.getByRole("main")
  await expect(main.getByRole("list", { name: "Chats" }).getByRole("link")).toHaveCount(50)
  const target = '[data-chat-id="paged-c-153"]'
  const row = main.getByRole("listitem").filter({ has: page.locator(target) })
  await row.hover()
  await row.getByRole("button", { name: "Delete Paged chat 153", exact: true }).click()
  await expect(main.locator(target)).toHaveCount(0)
  await page.getByRole("button", { name: "Undo", exact: true }).click()
  await expect(main.locator(target)).toHaveCount(1)
})

test("an unsent first message doesn't hold up logout, and is there after the next login", async ({ page }) => {
  const made = await admin((api) => api.CreateCard({ label: "Before logout", name: "Before logout" }))
  const text = "Typed before logging out, never sent"
  await page.goto(`${server().url}/cards/${made.entityId}/chat`)
  const message = page.getByRole("textbox", { name: "Message", exact: true })
  await expect(message).toBeEditable()
  await expect(page).toHaveURL(/[?&]draft=/)
  const pending = page.url()
  await message.fill(text)
  await logoutFromSettings(page)
  await expect(page).toHaveURL(/\/login/)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(pending)
  await expectTextBox(message, text)
})

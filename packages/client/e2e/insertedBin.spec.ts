// Synthetic insertions until the insertion RPC lands (unit 6). Exercise the existing
// registered composer, version actions and bin against the real writer and readers.
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { uuidv7 } from "@rp/shared/id.ts"
import type { SlotId } from "@rp/shared/chat.ts"
import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200", FAKE_GENERATOR_TOKENS: "40" })
type Api = Parameters<Parameters<typeof asUser>[3]>[0]
const admin = <A>(use: (api: Api) => Effect.Effect<A, unknown>) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shot = async (page: Page, name: string) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width
  )
  if (process.env.SCREENSHOT_DIR) {
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `${name}.png`), animations: "disabled" })
  }
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`inserted bin, deleted-tip send and swipe at ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const title = `Lantern gap ${width} ${theme}`
      const { chat, anchor } = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title })
          const root = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "The lantern keeper arrives.",
            reply: false
          })
          if (root._tag !== "Posted") throw new Error("queued")
          const tip = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: root.entry.slotId,
            branch: false,
            content: "The deleted anchor.",
            reply: false
          })
          if (tip._tag !== "Posted") throw new Error("queued")
          return { chat, anchor: tip.entry }
        })
      )
      const x = uuidv7() as SlotId,
        version = uuidv7(),
        at = Date.now()
      await Effect.runPromise(
        fixtureSql(server().dataDir, [
          {
            sql: "INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at,authoring_fork_id) VALUES(?,?,0,'complete','model',?,'verbatim','duplicate',?,?,?)",
            params: [version, x, "An inserted reply beside the lantern.", at, at, chat.currentForkId!]
          },
          {
            sql: "INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at,fork_id,inserted) VALUES(?,?,?,?,?,?,?,1)",
            params: [x, chat.id, anchor.slotId, anchor.depth + 1, version, at, chat.currentForkId]
          },
          { sql: "UPDATE chats SET state_seq = state_seq + 1 WHERE id = ?", params: [chat.id] },
          {
            sql: "INSERT INTO fork_overrides(id,chat_id,fork_id,seq,kind,target_id,slot_id,slot_depth,flag) SELECT ?,id,current_fork_id,state_seq,'insert',?,?,?,1 FROM chats WHERE id = ?",
            params: [uuidv7(), x, anchor.slotId, anchor.depth, chat.id]
          }
        ])
      )
      await admin((api) => api.DeleteMessage({ slotId: anchor.slotId, forkId: chat.currentForkId }))
      await page.goto(`${server().url}/chats/${chat.id}`)
      const inserted = page.getByRole("article").filter({ hasText: "An inserted reply beside the lantern." })
      await expect(inserted).toBeVisible()
      await expect(page.getByTestId("messages").getByText("The deleted anchor.")).toHaveCount(0)
      await inserted.getByRole("button", { name: "Generate another version" }).click()
      // Its text changes on regeneration, so locate by slot id for subsequent actions.
      const reply = page.locator(`[data-slot="${x}"]`)
      await expect(reply.getByRole("group", { name: "Versions" })).toContainText("2/2")
      await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
      await reply.getByRole("button", { name: "Previous version" }).click()
      await expect(inserted).toBeVisible()
      if (width === 1440)
        await expect(page.getByRole("link", { name: `Open chat ${title}`, exact: true }).first()).toContainText(
          "An inserted reply beside the lantern."
        )
      await shot(page, `chat-${width}-${theme}`)
      await page.getByTestId("composer").fill("After the gap.")
      await page.getByRole("button", { name: "Send", exact: true }).click()
      await expect(page.getByTestId("messages").getByText("After the gap.", { exact: true })).toBeVisible()
      await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
      await admin((api) =>
        Effect.gen(function* () {
          yield* api.CreateFork({ chatId: chat.id, fromForkId: chat.currentForkId, atSlotId: x })
          yield* api.DeleteMessage({ slotId: x, forkId: chat.currentForkId })
        })
      )
      await page.goto(`${server().url}/bin`)
      const row = page
        .getByRole("listitem", { name: new RegExp(`^Message \\d+ in “${title}”$`) })
        .filter({ hasText: "An inserted reply" })
      await expect(row).toBeVisible()
      await shot(page, `bin-${width}-${theme}`)
      await row.getByRole("button", { name: "Delete for good" }).click()
      const dialog = page.getByRole("alertdialog")
      await expect(dialog.getByText(/still shows? the text/)).toBeVisible()
      await shot(page, `warning-${width}-${theme}`)
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
      await row.getByRole("button", { name: "Restore", exact: true }).click()
      await page.goto(`${server().url}/chats/${chat.id}?fork=${chat.currentForkId}`)
      await expect(inserted).toBeVisible()
      await expect(page.getByTestId("messages").getByText("After the gap.", { exact: true })).toBeVisible()
      await shot(page, `restored-${width}-${theme}`)
    })

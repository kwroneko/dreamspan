import type { Page } from "@playwright/test"
import type { Copy } from "../src/features/editor/backup.ts"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { textField } from "@rp/shared/editing.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const copies = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Copy[]>((resolve, reject) => {
        const r = indexedDB.open("rp-editor-copies", 1)
        r.onsuccess = () => {
          const d = r.result
          const q = d.transaction("copies").objectStore("copies").getAll()
          q.onsuccess = () => {
            resolve(q.result)
            d.close()
          }
          q.onerror = () => reject(q.error)
        }
      })
  )
const put = (page: Page, copy: Copy) =>
  page.evaluate(
    (copy) =>
      new Promise<void>((resolve) => {
        const r = indexedDB.open("rp-editor-copies", 1)
        r.onupgradeneeded = () => {
          const s = r.result.createObjectStore("copies", { keyPath: "key" })
          s.createIndex("userId", "userId")
          s.createIndex("ref", ["userId", "refId"])
        }
        r.onsuccess = () => {
          const d = r.result
          const t = d.transaction("copies", "readwrite")
          t.objectStore("copies").put(copy)
          t.oncomplete = () => {
            d.close()
            resolve()
          }
        }
      }),
    copy
  )

test("refused live typing: logout retains it; explicit deletion permits logout; another account sees none", async ({
  page
}) => {
  const card = await admin((api) => api.CreateCard({ label: "Final recovery", name: "Final recovery" }))
  await admin((api) =>
    api.CreateUser({ handle: "final-reader", displayName: "Reader", role: "user", password: "reader-password-2" })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${card.id}`)
  const text = "UNACKNOWLEDGED-" + "z".repeat(1_000_001)
  await page.getByRole("textbox", { name: /^Description/ }).fill(text)
  await expect.poll(async () => (await copies(page)).map((x) => x.content)).toContain(text)
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Log out", exact: true }).click()
  const recovery = page.getByRole("dialog", { name: "Text kept in this browser", exact: true })
  await expect(recovery.getByRole("textbox", { name: "Recovery text" })).toHaveValue(text)
  await expect(page).toHaveURL(/\/library\//)
  await recovery.getByRole("button", { name: "Delete this copy" }).click()
  await page
    .getByRole("alertdialog", { name: "Delete this browser copy?" })
    .getByRole("button", { name: "Delete copy", exact: true })
    .click()
  await expect.poll(() => copies(page)).toEqual([])
  await recovery.getByRole("button", { name: "Keep copies" }).click()
  page.on("dialog", (d) => d.accept())
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Log out", exact: true }).click()
  await expect(page).toHaveURL(/\/login/)
  await apiLogin(page.request, server(), "final-reader", "reader-password-2")
  await page.goto(server().url)
  await page.getByRole("button", { name: "Browser recovery", exact: true }).click()
  await expect(page.getByText("No unsaved browser copies.", { exact: true })).toBeVisible()
  expect(await copies(page)).toEqual([])
})

test("expired A session retains its unsaved copy through B login and B logout", async ({ page }) => {
  await admin((api) =>
    api.CreateUser({ handle: "expiry-reader", displayName: "Reader", role: "user", password: "reader-password-2" })
  )
  const me = await admin((api) => api.Whoami())
  const card = await admin((api) => api.CreateCard({ label: "Account A", name: "Account A" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  const text = "A-only browser copy"
  const field = textField(["description"])
  const key = crypto.randomUUID()
  const copy: Copy = {
    key,
    userId: me.id,
    refId: card.id,
    field,
    content: text,
    at: Date.now(),
    ancestors: [],
    save: {
      kind: "editor",
      payload: {
        refId: card.id,
        field,
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: card.headRevisionId,
        content: text
      }
    }
  }
  await put(page, copy)
  // A's cookie disappears outside the UI, as on expiry; the browser database stays.
  await page.request.post(`${server().url}/auth/logout`)
  await apiLogin(page.request, server(), "expiry-reader", "reader-password-2")
  await page.goto(server().url)
  await page.getByRole("button", { name: "Browser recovery", exact: true }).click()
  await expect(page.getByText("No unsaved browser copies.", { exact: true })).toBeVisible()
  expect((await copies(page)).map((x) => x.content)).toEqual([text])
  await page.getByRole("button", { name: "Keep copies", exact: true }).click()
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Log out", exact: true }).click()
  await expect(page).toHaveURL(/\/login/)
  expect((await copies(page)).map((x) => x.content)).toEqual([text])
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${card.id}`)
  await expect(page.getByRole("textbox", { name: /^Description/ })).toHaveValue(text)
  await expect.poll(() => copies(page)).toEqual([])
})

for (const action of ["retry", "logout", "logout retry", "logout unsaved"] as const)
  test(`${action} of a stale composer copy explains that its text went to recovered texts`, async ({ page }) => {
    const seeded = await admin((api) =>
      Effect.gen(function* () {
        const me = yield* api.Whoami()
        const chat = yield* api.CreateChat({ title: "Recovered by retry" })
        const empty = yield* api.OpenComposer({ chatId: chat.id, tipSlotId: null })
        const saved = yield* api.SaveComposer({
          chatId: chat.id,
          draftId: empty.id,
          rowVersion: empty.rowVersion,
          session: empty.session,
          operationId: crypto.randomUUID(),
          next: false,
          content: "sent"
        })
        const d = saved.draft!
        yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          content: d.content,
          composer: { draftId: d.id, session: d.session }
        })
        return { me, chat, d }
      })
    )
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(server().url)
    const key = crypto.randomUUID()
    const text = "Unsaved typing from the ended session"
    const { me, chat, d } = seeded
    await put(page, {
      key,
      userId: me.id,
      refId: `composer:${chat.id}`,
      field: d.id,
      content: text,
      at: Date.now(),
      ancestors: [],
      save: {
        kind: "composer",
        payload: {
          chatId: chat.id,
          draftId: d.id,
          rowVersion: d.rowVersion,
          session: d.session,
          next: false,
          operationId: key,
          content: text
        }
      }
    })
    if (action !== "retry") {
      if (action === "logout unsaved") {
        const refusedKey = crypto.randomUUID()
        const content = "z".repeat(1_000_001)
        await put(page, {
          key: refusedKey,
          userId: me.id,
          refId: `composer:${chat.id}`,
          field: d.id,
          content,
          at: Date.now(),
          ancestors: [],
          save: {
            kind: "composer",
            payload: {
              chatId: chat.id,
              draftId: d.id,
              rowVersion: d.rowVersion,
              session: d.session,
              next: false,
              operationId: refusedKey,
              content
            }
          }
        })
        await page
          .getByRole("navigation", { name: "Main" })
          .getByRole("button", { name: "Log out", exact: true })
          .click()
        const recovery = page.getByRole("dialog", { name: "Text kept in this browser", exact: true })
        await expect(recovery.locator('a[href="/bin?section=recovered"]')).toBeVisible()
        await expect(recovery.getByRole("textbox", { name: "Recovery text" })).toHaveValue(content)
        await recovery.getByRole("button", { name: "Delete this copy" }).click()
        await page
          .getByRole("alertdialog", { name: "Delete this browser copy?" })
          .getByRole("button", { name: "Delete copy", exact: true })
          .click()
        await recovery.getByRole("button", { name: "Keep copies", exact: true }).click()
      }
      if (action === "logout retry") {
        await page.route("**/auth/logout", (route) => route.fulfill({ status: 503 }), { times: 1 })
        await page
          .getByRole("navigation", { name: "Main" })
          .getByRole("button", { name: "Log out", exact: true })
          .click()
        await expect(page.getByRole("alert")).toContainText("couldn't log you out")
        await expect(page.locator('a[href="/bin?section=recovered"]')).toBeVisible()
      }
      await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Log out", exact: true }).click()
      await expect(page).toHaveURL(/\/login/)
      await expect(page.locator('a[href="/bin?section=recovered"]')).toBeVisible()
      await page.reload()
      await expect(page.locator('a[href="/bin?section=recovered"]')).toBeVisible()
    } else {
      await page.getByRole("button", { name: "Browser recovery", exact: true }).click()
      const recovery = page.getByRole("dialog", { name: "Text kept in this browser", exact: true })
      await expect(recovery.getByRole("textbox", { name: "Recovery text" })).toHaveValue(text)
      await recovery.getByRole("button", { name: "Retry saving", exact: true }).click()
      await expect(recovery.getByText("No unsaved browser copies.", { exact: true })).toBeVisible()
      await expect(recovery.locator('a[href="/bin?section=recovered"]')).toHaveCount(1)
      await recovery.getByRole("button", { name: "Retry saving", exact: true }).click()
      await expect(recovery.locator('a[href="/bin?section=recovered"]')).toHaveCount(1)
      await recovery.getByRole("button", { name: "Keep copies", exact: true }).click()
      await page.getByRole("button", { name: "Browser recovery", exact: true }).click()
      await expect(recovery.locator('a[href="/bin?section=recovered"]')).toHaveCount(1)
    }
    expect(
      (await admin((api) => api.ListRecoveredTexts({ limit: 100, before: null }))).some((x) => x.content === text)
    ).toBe(true)
  })

test("reverting a field links to its recovered text", async ({ page }) => {
  const card = await admin((api) => api.CreateCard({ label: "N5 revert", name: "N5 revert" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${card.id}`)
  const box = page.getByRole("textbox", { name: /^Description/ })
  await box.fill("N5 REVERT RECOVERY 857194")
  await expect
    .poll(() => admin((api) => api.OpenEditor({ refId: card.id })).then((x) => x.drafts[0]?.content))
    .toBe("N5 REVERT RECOVERY 857194")
  await page.getByRole("button", { name: "Revert Description", exact: true }).click()
  await expect(box).toHaveValue("")
  const recovered = await admin((api) => api.ListRecoveredTexts({ limit: 10, before: null }))
  expect(recovered.some((x) => x.content === "N5 REVERT RECOVERY 857194")).toBe(true)
  const links = await page.locator('a[href="/bin?section=recovered"]').count()
  expect(links).toBeGreaterThan(0)
})

test("removing a module keeps its source recovery link", async ({ page }) => {
  const card = await admin((api) => api.CreateCard({ label: "Module recovery", name: "Synthetic" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${card.id}`)
  await page.getByRole("button", { name: "Add a module", exact: true }).click()
  const module = page.getByRole("region", { name: "Module New module", exact: true })
  await module.getByRole("textbox", { name: /^Content/ }).fill("Module text kept after removal")
  await expect
    .poll(() =>
      admin((api) => api.OpenEditor({ refId: card.id })).then((editor) =>
        editor.drafts.some((draft) => draft.content === "Module text kept after removal")
      )
    )
    .toBe(true)
  await module.getByRole("button", { name: "Remove the module", exact: true }).click()
  await expect(module).toHaveCount(0)
  await expect(page.locator('a[href="/bin?section=recovered"]')).toHaveCount(1)
  expect(
    (await admin((api) => api.ListRecoveredTexts({ limit: 10, before: null }))).some(
      (text) => text.content === "Module text kept after removal"
    )
  ).toBe(true)
})

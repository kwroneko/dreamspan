import { expectTextBox } from "./support/textbox.ts"
// Real shutdowns and persistent profiles: no injected copies or simulated RPC failures.
import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { Effect } from "effect"
import { textField } from "@dreamspan/shared/editing.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { NOTHING_TO_SAVE, expectSaveState, saveButton, saveRevision } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, startServer, withAdmin } from "./support/server.ts"

const offline = "A synthetic thought typed in the offline browser."
const elsewhere = "A different synthetic thought saved elsewhere."
const field = textField(["description"])

/** Wait for the actual typing's IndexedDB transaction, then close the whole context. */
const browserCopy = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Array<{ content: string; at: number }>>((done, fail) => {
        const opening = indexedDB.open("dreamspan-editor-copies", 1)
        opening.onerror = () => fail(opening.error)
        opening.onsuccess = () => {
          const db = opening.result
          const tx = db.transaction("copies", "readonly")
          const reading = tx.objectStore("copies").getAll()
          reading.onsuccess = () => done(reading.result as Array<{ content: string; at: number }>)
          tx.oncomplete = () => db.close()
        }
      })
  )

for (const kind of ["composer", "editor"] as const) {
  for (const variant of ["unchanged", "conflicting draft", "committed elsewhere"] as const) {
    test(`${kind}: offline typing survives browser closure and server restart (${variant})`, async ({
      playwright,
      browserName
    }, info) => {
      test.setTimeout(120_000)
      const server = await startServer(withAdmin)
      const contexts = new Set<BrowserContext>()
      const launch = async (profile: string) => {
        const context = await playwright[browserName].launchPersistentContext(info.outputPath(profile))
        contexts.add(context)
        return context
      }
      try {
        const cookie = await loginCookie(server, ADMIN.handle, ADMIN.password)
        const rpc = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server, cookie, use)
        const chat = await rpc((api) => api.CreateChat({ title: "Synthetic offline chat" }))
        const card = await rpc((api) => api.CreateCard({ label: "Synthetic offline card", name: "Synthetic" }))
        const path = kind === "composer" ? `/chats/${chat.id}` : `/library/${card.id}`
        const box = (page: Page) =>
          page.getByRole("textbox", {
            name: kind === "composer" ? "Message" : /^Description/,
            exact: kind === "composer"
          })
        const saved = () =>
          rpc((api) =>
            kind === "composer"
              ? Effect.gen(function* () {
                  return yield* api.OpenComposer({ chatId: chat.id, forkId: null })
                })
              : Effect.map(api.OpenEditor({ refId: card.id }), (editor) =>
                  editor.drafts.find((draft) => draft.key.field === field)!
                )
          )
        const first = await launch("first-profile")
        const page = first.pages()[0]!
        await apiLogin(first.request, server, ADMIN.handle, ADMIN.password)
        await page.goto(`${server.url}${path}`)
        await expect(box(page)).toBeEditable()
        await server.pause()
        await expect
          .poll(() =>
            fetch(`${server.url}/healthz`).then(
              () => false,
              () => true
            )
          )
          .toBe(true)
        await box(page).fill(offline)
        await expect.poll(async () => (await browserCopy(page)).map((copy) => copy.content)).toContain(offline)
        const copy = (await browserCopy(page)).find((copy) => copy.content === offline)!
        await first.close()
        contexts.delete(first)
        await server.restart()

        let otherAt: number | undefined
        if (variant !== "unchanged") {
          const second = await launch("second-profile")
          await apiLogin(second.request, server, ADMIN.handle, ADMIN.password)
          const other = second.pages()[0]!
          await other.goto(`${server.url}${path}`)
          await expect(box(other)).toBeEditable()
          await box(other).fill(elsewhere)
          await expect.poll(async () => (await saved())?.content).toBe(elsewhere)
          otherAt = (await saved()).updatedAt
          if (variant === "committed elsewhere") {
            if (kind === "composer") {
              await other.getByRole("button", { name: "Send", exact: true }).click()
              await expect(other.getByRole("article", { name: "Your message" })).toContainText(elsewhere)
              await expectTextBox(box(other), "")
            } else {
              await saveRevision(other)
              await expectSaveState(other, NOTHING_TO_SAVE)
            }
          }
          await second.close()
          contexts.delete(second)
        }
        const returning = await launch("first-profile")
        const back = returning.pages()[0]!
        // Login cookie and IndexedDB both survive reopening this profile.
        await back.goto(`${server.url}${path}`)
        if (kind === "composer" && variant === "committed elsewhere") {
          await expectTextBox(box(back), "")
          await expect(back.getByRole("article", { name: "Your message" })).toContainText(elsewhere)
          // Said once, in a toast with the way to the bin, never in the composer.
          const toast = back.locator("[data-toast]").filter({
            hasText: "Unsent text from “Synthetic offline chat” was moved to the bin."
          })
          await expect(toast).toHaveCount(1)
          await expect(back.getByRole("status").filter({ hasText: "bin" })).toHaveCount(0)
          await toast.getByRole("button", { name: "Open the bin", exact: true }).click()
          await expect(back.getByText(offline, { exact: true })).toBeVisible()
          expect((await saved())?.content).toBe("")
        } else {
          await expectTextBox(box(back), offline)
          await expect.poll(async () => (await saved())?.content).toBe(offline)
          if (variant === "conflicting draft") {
            const notice = back
              .getByRole("status")
              .filter({ hasText: "This browser's text replaced text saved elsewhere" })
            await expect(notice).toBeVisible()
            // Assert the writer's timestamp and this browser's copy timestamp are both shown.
            const times = await back.evaluate(
              ([typed, saved]) =>
                [typed, saved].map((at) =>
                  new Date(at!).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" })
                ),
              [copy.at, otherAt]
            )
            for (const time of times) await expect(notice).toContainText(time)
            await notice.getByText("View the other text", { exact: true }).click()
            await expect(notice.getByText(elsewhere, { exact: true })).toBeVisible()
            const current = await saved()
            expect(current.displaced).toBeNull() // reads never manufacture a conflict
            const history = await rpc((api) =>
              kind === "composer"
                ? api.ComposerHistory({ chatId: chat.id, draftId: current.id, limit: 50 })
                : api.EditorDraftHistory({ refId: card.id, field, limit: 50 })
            )
            expect(history[1]?.length).toBe(elsewhere.length) // the displaced text is one step back
            await notice.getByRole("button", { name: "Use the other text" }).click()
            await expectTextBox(box(back), elsewhere)
            await expect(notice).toHaveCount(0)
            await expect.poll(async () => (await saved())?.content).toBe(elsewhere)
            if (kind === "composer") {
              await back.getByRole("button", { name: "Earlier text of this message" }).click()
              await back
                .getByRole("dialog", { name: "Earlier text" })
                .getByRole("button")
                .filter({ hasText: `${offline.length} characters` })
                .first()
                .click()
            } else {
              // One step back in the field's edit history: this browser's text, put back as the newest.
              await back.getByRole("button", { name: "Edit history of Description", exact: true }).click()
              const states = back.getByRole("dialog", { name: "Edit history: Description" })
              await expect(states.getByLabel("Text of the state")).toHaveText(offline)
              await states.getByRole("button", { name: "Put this text in the box", exact: true }).click()
              await expect(states).toHaveCount(0)
            }
            await expectTextBox(box(back), offline)
            await expect.poll(async () => (await saved())?.content).toBe(offline)
          } else {
            // The composer just shows the text as it was typed; an editor says where it came from.
            if (kind === "editor")
              await expect(back.getByRole("status").filter({ hasText: "Brought back from this browser" })).toBeVisible()
            else await expect(back.locator("[data-toast]")).toHaveCount(0)
            if (variant === "committed elsewhere") {
              const revision = await rpc((api) => api.OpenEditor({ refId: card.id }))
              expect(revision.doc.description).toBe(elsewhere)
              // Saving this alternative must meet the editor's existing revision conflict picker.
              await saveButton(back).click()
              const conflict = back.getByRole("dialog", { name: "Changed meanwhile" })
              await expect(conflict.getByText(elsewhere, { exact: true })).toBeVisible()
              await expect(conflict.getByText(offline, { exact: true })).toBeVisible()
            }
          }
        }
        expect(await browserCopy(back)).toEqual([])
      } finally {
        for (const context of contexts) await context.close()
        await server.stop()
      }
    })
  }
}

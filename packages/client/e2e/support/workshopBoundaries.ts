import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./layoutAudit.ts"
import { asUser } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"

export function workshopBoundaryTests() {
  test.describe("workshop boundaries", () => {
    const server = serverPerFile(withAdmin)
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const)
        test(`${width} ${theme}`, async ({ page }, info) => {
          const { workshop, story } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
            Effect.gen(function* () {
              const workshop = yield* api.CreateWorkshop({ title: `Workshop boundary ${width} ${theme}` })
              const story = yield* api.CreateChat({ title: `Story boundary ${width} ${theme}` })
              yield* api.SendMessage({
                chatId: story.id,
                parentSlotId: null,
                branch: false,
                content: "Synthetic story."
              })
              return { workshop, story }
            })
          )
          await page.setViewportSize({ width, height: 900 })
          await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
          await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
          await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
          await page.goto(`${server().url}/chats/${workshop.id}`)
          await expect(page.getByTestId("composer")).toBeVisible()
          await page.getByRole("button", { name: "Chat actions", exact: true }).click()
          await page.getByRole("menuitem", { name: "Export…", exact: true }).click()
          const exported = page.getByRole("dialog", { name: "Export this chat", exact: true })
          await expect(exported.getByRole("button", { name: "Plain text (.txt)", exact: true })).toHaveAttribute(
            "aria-pressed",
            "true"
          )
          await expect(exported.getByRole("button", { name: "SillyTavern (.jsonl)", exact: true })).toHaveCount(0)
          await expectLayout(page, info, "workshop-export", { scope: '[role="dialog"]' })
          const download = page.waitForEvent("download")
          await exported.getByRole("button", { name: "Export", exact: true }).click()
          expect((await download).suggestedFilename()).toMatch(/\.txt$/)
          await expect(exported).toHaveCount(0)
          await page.goto(`${server().url}/chats/${story.id}`)
          await expect(page.getByTestId("composer")).toBeVisible()
          await page.getByRole("button", { name: "Chat actions", exact: true }).click()
          await page.getByRole("menuitem", { name: "Merge another chat…", exact: true }).click()
          const merge = page.getByRole("dialog", { name: "Merge a chat into this one", exact: true })
          await expect(merge.getByRole("button", { name: `${story.title} This chat`, exact: true })).toBeVisible()
          await merge.getByRole("searchbox", { name: "Chat to merge" }).fill(workshop.title)
          await expect(merge.getByText("No chats match.", { exact: true })).toBeVisible()
          await expect(merge.getByRole("button", { name: workshop.title, exact: true })).toHaveCount(0)
          await expectLayout(page, info, "workshop-merge-source", { scope: '[role="dialog"]' })
          await merge.getByRole("button", { name: "Cancel", exact: true }).click()
        })
  })
}

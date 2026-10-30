import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const refuseDraftSaves = async (page: Page, refuse: () => boolean) => {
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: string }) : null
      if (refuse() && request?.tag === "SaveUserDraft") {
        socket.send(
          JSON.stringify({
            _tag: "Exit",
            requestId: request.id,
            exit: {
              _tag: "Failure",
              cause: [{ _tag: "Fail", error: { _tag: "ServerError", message: "Synthetic draft refusal" } }]
            }
          })
        )
      } else upstream.send(data)
    })
    upstream.onMessage((data) => socket.send(data))
  })
}

for (const scheme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`open private drafts refresh and resolve conflicts across devices at ${width} (${scheme})`, async ({
      page,
      browser
    }) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      const common = "Preserve the keeper’s promises, debts, and quiet obligations through every scene. "
      const localText = `${common}Local unsaved ${width}`
      const remoteText = `${common}Other device newer ${width}`
      let refuse = false
      await refuseDraftSaves(page, () => refuse)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(server().url + "/settings/chats")
      const box = page.getByLabel("Summarization instruction", { exact: true })
      await expect(box).toBeVisible()
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme })
      const other = await context.newPage()
      try {
        await apiLogin(other.request, server(), ADMIN.handle, ADMIN.password)
        await other.goto(server().url + "/settings/chats")
        const remote = other.getByLabel("Summarization instruction", { exact: true })
        await remote.fill(`Remote saved ${width}`)
        await expect(box).toHaveValue(`Remote saved ${width}`)
        refuse = true
        await box.fill(localText)
        await expect(
          page.getByText("Something failed on the server. The details are in the server's log.")
        ).toBeVisible()
        await remote.fill(remoteText)
        const notice = page.getByText("Another device saved a different draft. Your unsaved text is still here.")
        await expect(notice).toBeVisible()
        await expect(box).toHaveValue(localText)
        await page.getByText("Preview the other device's text").click()
        await expect(page.getByRole("status").getByText(remoteText, { exact: true })).toBeVisible()
        if (process.env.SCREENSHOT_DIR)
          await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/draft-conflict-${width}-${scheme}.png` })
        refuse = false
        await page.getByRole("button", { name: "Load the other device's text", exact: true }).click()
        await expect(box).toHaveValue(remoteText)
        await expect(notice).toHaveCount(0)
        const restoredLocal = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          Effect.gen(function* () {
            const user = yield* api.Whoami()
            const address = { ownerId: user.id, targetId: "Settings → Chats", field: "Summarization instruction" }
            const current = yield* api.GetUserDraft(address)
            const history = yield* api.UserDraftHistory(address)
            return (yield* api.RestoreUserDraft({
              ...address,
              draftId: current!.id,
              expectedRowVersion: current!.rowVersion,
              seq: history[1]!.seq
            })).content
          })
        )
        expect(restoredLocal).toBe(localText)
        await expect(box).toHaveValue(localText)
        refuse = true
        await box.fill(`Keep this local text ${width}`)
        await expect(
          page.getByText("Something failed on the server. The details are in the server's log.")
        ).toBeVisible()
        await remote.fill(`Another remote edit ${width}`)
        await expect(notice).toBeVisible()
        refuse = false
        await page.getByRole("button", { name: "Keep my text", exact: true }).click()
        await expect(notice).toHaveCount(0)
        await expect(box).toHaveValue(`Keep this local text ${width}`)
        await expect
          .poll(() =>
            asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
              Effect.gen(function* () {
                const user = yield* api.Whoami()
                return (yield* api.GetUserDraft({
                  ownerId: user.id,
                  targetId: "Settings → Chats",
                  field: "Summarization instruction"
                }))?.content
              })
            )
          )
          .toBe(`Keep this local text ${width}`)
      } finally {
        await context.close()
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    })
  }

for (const scheme of ["light", "dark"] as const)
  for (const width of [1440, 390]) {
    test(`a remote commit keeps a dirty JSON form safe and reloads the actual saved setting at ${width} (${scheme})`, async ({
      page,
      browser
    }) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      const connection = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Original connection",
            baseUrl: "http://127.0.0.1:1/v1",
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
      )
      let refuse = false
      await refuseDraftSaves(page, () => refuse)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const path = `${server().url}/settings/connections/${connection.id}`
      await page.goto(path)
      const name = page.getByLabel("Name", { exact: true })
      await expect(name).toHaveValue("Original connection")
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme })
      const other = await context.newPage()
      try {
        await apiLogin(other.request, server(), ADMIN.handle, ADMIN.password)
        await other.goto(path)
        await other.getByLabel("Name", { exact: true }).fill("Saved on the other device")
        await expect(name).toHaveValue("Saved on the other device")
        refuse = true
        await name.fill("Only in this browser")
        await expect(
          page.getByText("Something failed on the server. The details are in the server's log.").first()
        ).toBeVisible()
        await other.getByRole("button", { name: "Save", exact: true }).click()
        await expect(page.getByText(/Another device finished this draft/)).toBeVisible()
        await expect(name).toHaveValue("Only in this browser")
        if (process.env.SCREENSHOT_DIR)
          await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/draft-ended-${width}-${scheme}.png` })
        // Loading cannot discard a copy that the server has refused.
        await page.getByRole("button", { name: "Reload saved value", exact: true }).click()
        await expect(name).toHaveValue("Only in this browser")
        await expect(page.getByText(/Another device finished this draft/)).toBeVisible()
        refuse = false
        await page.getByRole("button", { name: "Reload saved value", exact: true }).click()
        await expect(name).toHaveValue("Saved on the other device")
        const recovered = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          Effect.gen(function* () {
            const texts = yield* api.ListRecoveredTexts({ limit: 100, before: null })
            const copy = texts.find(
              (text) => text.sourceId === `connection:${connection.id}` && text.content.includes("Only in this browser")
            )!
            return (yield* api.GetRecoveredText({ id: copy.id })).content
          })
        )
        expect(JSON.parse(recovered).name).toBe("Only in this browser")
      } finally {
        await context.close()
      }
    })
  }

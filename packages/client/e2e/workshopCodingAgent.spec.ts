import { expect, test, type Locator, type Page } from "@playwright/test"
import { Effect } from "effect"
import { textField } from "@dreamspan/shared/editing.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { showActions } from "./support/message.ts"
import { loginCookie, withCookie, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, type TestServer, withAdmin } from "./support/server.ts"
import { startWorkshopProvider } from "./support/workshopProvider.ts"

const server = serverPerFile(withAdmin)
const sessions = new WeakMap<TestServer, Promise<string>>()
const admin = async <A>(use: (api: Client) => Effect.Effect<A, unknown>) => {
  const host = server()
  let session = sessions.get(host)
  if (!session) {
    session = loginCookie(host, ADMIN.handle, ADMIN.password)
    sessions.set(host, session)
  }
  return withCookie(host, await session, use)
}

const useProvider = (baseUrl: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",

        settings: {
          providerSettings: { toolLoading: "every" },
          name: "Workshop fixture",
          baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "workshop-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
    })
  )

const open = async (page: Page, id: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${id}`)
  await expect(page.getByTestId("composer")).toBeVisible()
}
const send = async (page: Page, text: string) => {
  await page.getByLabel("Message", { exact: true }).fill(text)
  await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
}
const layout = (reply: Locator) =>
  reply.locator("[data-workshop-text], [data-workshop-trace], footer").evaluateAll((elements) =>
    elements.map((element) => {
      const { top, left, width, height } = element.getBoundingClientRect()
      return { top, left, width, height }
    })
  )
const editable = (reply: Locator) => reply.locator("[data-workshop-text] [contenteditable=true]")
const cancel = (reply: Locator) => reply.getByRole("button", { name: "Cancel", exact: true }).click()
const swipe = async (reply: Locator) => {
  await showActions(reply)
  await reply.getByRole("button", { name: "Generate another swipe", exact: true }).click()
}

test.setTimeout(100_000)

for (const width of [1440, 390])
  for (const theme of ["dark", "light"] as const)
    test(`interleaved live blocks, reload and zero-shift edit at ${width} ${theme}`, async ({ page }) => {
      const provider = await startWorkshopProvider({
        perTask: true,
        calls: [
          { name: "read_card", arguments: { card: "Assistant", fields: ["description"] }, prose: "Prose one." },
          { name: "read_card", arguments: { card: "Assistant", fields: ["description"] }, prose: "Prose two." }
        ],
        answer: "Final prose."
      })
      try {
        await useProvider(provider.baseUrl)
        const chat = await admin((api) => api.CreateWorkshop({}))
        await page.setViewportSize({ width, height: width === 390 ? 1000 : 1050 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((mode) => localStorage.setItem("dreamspan.theme", mode), theme)
        await open(page, chat.id)
        provider.hold(1)
        await send(page, "Produce the layout fixture.")
        const reply = page
          .getByRole("article")
          .filter({ has: page.locator("[data-workshop-text]") })
          .last()
        await expect(reply.locator("[data-workshop-text]")).toHaveText(["Prose one."])
        await expect(reply.locator("[data-workshop-trace]")).toHaveCount(1)
        provider.release()
        provider.hold(2)
        await expect(reply.locator("[data-workshop-text]")).toHaveText(["Prose one.", "Prose two."])
        await expect(reply.locator("[data-workshop-trace]")).toHaveCount(2)
        await expect(reply.getByText("Writing…", { exact: true })).toHaveCount(0)
        provider.release()
        await expect(reply.locator("[data-workshop-text]")).toHaveText(["Prose one.", "Prose two.", "Final prose."])
        const order = reply.locator("[data-workshop-text], [data-workshop-trace]")
        await expect(order).toHaveText(["Prose one.", "1 step", "Prose two.", "1 step", "Final prose."], {
          useInnerText: true
        })
        await expect(page.getByRole("article").filter({ hasText: "Final prose." })).toHaveCount(1)
        const traces = reply.locator("[data-workshop-trace]")
        await traces.first().getByRole("button").click()
        await expect(traces.first().getByRole("link", { name: "Open the run" })).toBeVisible()
        await expect(traces.last().locator("[data-step]")).toHaveCount(0)
        await traces.first().getByRole("button").first().click()
        // Both trace controls and every text block occupy their saved places on the first loaded render.
        await page.mouse.move(0, 0)
        const saved = await layout(reply)
        await page.reload()
        await expect(order).toHaveText(["Prose one.", "1 step", "Prose two.", "1 step", "Final prose."], {
          useInnerText: true
        })
        expect(await layout(reply)).toEqual(saved)

        for (const index of [0, 1, 2]) {
          const block = reply.locator("[data-workshop-text]").nth(index)
          const expected = await layout(reply)
          await block.locator(".markdown").dblclick({ position: { x: 14, y: 10 } })
          await expect(editable(reply)).toHaveCount(3)
          await expect(editable(reply).nth(index)).toBeFocused()
          expect(await layout(reply)).toEqual(expected)
          await cancel(reply)
          await expect(editable(reply)).toHaveCount(0)
          expect(await layout(reply)).toEqual(expected)
        }
        await showActions(reply)
        const beforeEdit = await layout(reply)
        const edit = reply.getByRole("button", { name: "Edit", exact: true })
        if (await edit.isVisible()) await edit.click()
        else {
          await reply.getByRole("button", { name: "More actions" }).click()
          await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
        }
        await expect(editable(reply).last()).toBeFocused()
        expect(await layout(reply)).toEqual(beforeEdit)
        await editable(reply).first().fill("Prose new.")
        if (width === 1440 && theme === "dark") {
          await expect
            .poll(async () =>
              (await admin((api) => api.MessageDrafts({ chatId: chat.id }))).some(
                (draft) => draft.key.field.startsWith("block:") && draft.content === "Prose new."
              )
            )
            .toBe(true)
          await page.reload()
          await expect(editable(reply)).toHaveCount(3)
          await expect(editable(reply).first()).toHaveText("Prose new.")
          expect(await layout(reply)).toEqual(beforeEdit)
        }
        await reply.getByRole("button", { name: "Save", exact: true }).click()
        await expect(editable(reply)).toHaveCount(0)
        await expect(order).toHaveText(["Prose new.", "1 step", "Prose two.", "1 step", "Final prose."], {
          useInnerText: true
        })
        expect(await layout(reply)).toEqual(beforeEdit)
        await page.reload()
        await expect(order).toHaveText(["Prose new.", "1 step", "Prose two.", "1 step", "Final prose."], {
          useInnerText: true
        })
        const before = provider.bodies.length
        await send(page, "Check the edited history.")
        await expect.poll(() => JSON.stringify(provider.bodies.slice(before))).toContain("Prose new.")
      } finally {
        await provider.stop()
      }
    })

const changeDescription = (refId: RefId, content: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const field = textField(["description"])
      const opened = yield* api.OpenEditor({ refId })
      const draft = yield* api.SaveEditorDraft({
        refId,
        field,
        content,
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: opened.ref.headRevisionId
      })
      yield* api.CommitEditorDrafts({
        refId,
        expectedRowVersion: opened.ref.rowVersion,
        fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
        message: null
      })
    })
  )

for (const scenario of ["success", "failure", "manual", "earlier"] as const)
  test(`workshop swipe with ${scenario} changes`, async ({ page }) => {
    const card = await admin((api) =>
      api.CreateCard({ label: "Swipe fixture", name: "Swipe fixture", description: "Original description." })
    )
    const createdName = `Created by the ${scenario} fixture`
    let retry = false
    const provider = await startWorkshopProvider({
      perTask: true,
      calls: [
        { name: "read_card", arguments: { card: "Swipe fixture", fields: ["description"] } },
        {
          name: "edit_card",
          arguments: () => ({
            card: "Swipe fixture",
            changes: [{ field: "description", text: retry ? "Second revision." : "First revision." }]
          })
        },
        {
          name: "create_card",
          arguments: () => ({ name: retry ? `Retry of ${createdName}` : createdName, description: "Synthetic card." })
        }
      ],
      answer: () => (retry ? "Second swipe finished." : "First swipe finished."),
      fail: (_body, round) => retry && round === 0 && scenario === "failure"
    })
    try {
      await useProvider(provider.baseUrl)
      const chat = await admin((api) => api.CreateWorkshop({ card: card.entityId }))
      await open(page, chat.id)
      await send(page, "Make the swipe fixture changes.")
      const first = page.getByRole("article").filter({ hasText: "First swipe finished." }).first()
      await expect(first).toBeVisible()
      const read = () => admin((api) => api.OpenEditor({ refId: card.id }))
      const library = () => admin((api) => api.ListLibrary({ kind: "card" }))
      const afterFirst = await read()
      expect(afterFirst.doc.description).toBe("First revision.")
      expect((await library()).some((item) => item.label === createdName)).toBe(true)
      if (scenario === "manual") await changeDescription(card.id, "Manually changed.")
      if (scenario === "earlier") {
        await send(page, "Add a later turn.")
        await expect(page.getByRole("article").filter({ hasText: "First swipe finished." })).toHaveCount(2)
      }
      retry = true
      await swipe(first)
      const warning = page.getByRole("dialog", { name: "This reply changed things outside the chat" })
      if (scenario === "manual" || scenario === "earlier") {
        await expect(warning).toBeVisible()
        await expect(warning.getByRole("button", { name: "Keep & swipe" })).toBeEnabled()
        if (scenario === "manual") await expect(warning).toContainText("You edited this item since this reply.")
        else await expect(warning).toContainText("earlier in the chat")
        await warning.getByRole("button", { name: "Cancel", exact: true }).click()
        if (scenario === "manual") {
          const manual = await read()
          await page.reload()
          await page.locator("[data-change-rows]").getByRole("button", { name: "Restore this version" }).click()
          const confirm = page.getByRole("alertdialog", { name: /Restore this version/ })
          await expect(confirm).toContainText("Those edits will remain in Versions.")
          await confirm.getByRole("button", { name: "Restore this version" }).click()
          await expect.poll(async () => (await read()).doc.description).toBe("First revision.")
          const preserved = await admin((api) =>
            api.GetRevision({ refId: card.id, revisionId: manual.ref.headRevisionId })
          )
          expect(preserved.description).toBe("Manually changed.")
        }
        return
      }
      await expect(warning).toHaveCount(0)
      if (scenario === "failure") {
        await expect(page.getByText(/Failed \(/)).toBeVisible({ timeout: 40_000 })
        await expect.poll(async () => (await read()).doc.description).toBe("First revision.")
        expect((await library()).some((item) => item.label === createdName)).toBe(true)
        return
      }
      const second = page.getByRole("article").filter({ hasText: "Second swipe finished." })
      await expect(second).toBeVisible()
      expect(JSON.stringify(provider.bodies)).toContain("Original description.")
      const afterSecond = await read()
      expect(afterSecond.doc.description).toBe("Second revision.")
      expect((await library()).some((item) => item.label === createdName)).toBe(false)
      await showActions(second)
      await second.getByRole("button", { name: "Previous swipe" }).click()
      const rows = page.locator("[data-change-rows]")
      await rows.getByRole("button", { name: "Restore this version", exact: true }).click()
      await expect(page.getByRole("alertdialog")).toHaveCount(0)
      await expect.poll(async () => (await read()).doc.description).toBe("First revision.")
      await rows.getByRole("button", { name: "Restore", exact: true }).click()
      await expect.poll(async () => (await library()).some((item) => item.label === createdName)).toBe(true)
      const kept = await admin((api) => api.GetRevision({ refId: card.id, revisionId: afterSecond.ref.headRevisionId }))
      expect(kept.description).toBe("Second revision.")
    } finally {
      await provider.stop()
    }
  })

test("an irreversible command alone allows a tip swipe without a dialog", async ({ page }) => {
  let retry = false
  const provider = await startWorkshopProvider({
    perTask: true,
    calls: [{ name: "bash", arguments: { command: "printf 'synthetic command output'" } }],
    answer: () => (retry ? "Command retry finished." : "Command finished.")
  })
  try {
    await useProvider(provider.baseUrl)
    const chat = await admin((api) => api.CreateWorkshop({}))
    await open(page, chat.id)
    await send(page, "Run the harmless command fixture.")
    const first = page.getByRole("article").filter({ hasText: "Command finished." })
    await expect(first).toBeVisible()
    const effects = await admin((api) => api.ListRolloutEffects({ chatId: chat.id }))
    expect(effects.map(({ kind, undo }) => ({ kind, undo }))).toEqual([{ kind: "shell.run", undo: null }])
    retry = true
    await swipe(first)
    await expect(page.getByRole("dialog", { name: "This reply changed things outside the chat" })).toHaveCount(0)
    await expect(page.getByRole("article").getByText("Command retry finished.", { exact: true })).toBeVisible()
  } finally {
    await provider.stop()
  }
})

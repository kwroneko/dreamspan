// Resuming agent replies in the browser (spec/AGENTIC.md §4.2, §4.4, §5.2, §5.3; DESIGN §7.5),
// with the scripted provider agentSteps uses (two search_chat calls, then the reply). A reply
// stopped after its first call offers Resume among its actions; resuming shows a new version
// being written, and a second Resume of the stopped one while that runs is refused in plain words.
// A reply whose request failed resumes the same way. In the run inspector, a call's result is
// edited and the run carried on from it as a new version; that version's inspector shows what the
// edit cut, folded. Layout audit on the message and the inspector, at 1440 and 390, light and dark.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Locator, test } from "@playwright/test"
import { Effect } from "effect"
import type { SlotId } from "@rp/shared/chat.ts"
import { AGENT_REPLY, startAgentProvider } from "./agentProvider.ts"
import { expectLayout } from "./layoutAudit.ts"
import { messageMenu, showActions } from "./message.ts"
import { asUser } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"

export function agentResumeTests() {
  const server = serverPerFile(withAdmin)
  const shots = process.env.SCREENSHOT_DIR
  let provider: Awaited<ReturnType<typeof startAgentProvider>>
  test.beforeAll(async () => {
    provider = await startAgentProvider()
  })
  test.afterAll(async () => {
    await provider.stop()
  })

  const EDITED = "Message 1 says the bridge washed away last spring."

  /**
   * Shows the actions of `reply`, whose body may be empty (a reply stopped before any text): on a
   * narrow screen by a tap on its status, a badge or note that's plain text.
   */
  const reveal = async (reply: Locator) => {
    const narrow = (reply.page().viewportSize()?.width ?? 1280) < 640
    if (!narrow) return showActions(reply)
    if ((await reply.getByRole("toolbar", { name: "Message actions" }).count()) > 0) return
    await reply
      .getByText(/^(stopped|Failed \(.*)$/)
      .first()
      .click()
  }

  /** Chooses Resume on `reply`: a button when it fits beside the others, else in More actions. */
  const resume = async (reply: Locator) => {
    await reveal(reply)
    const button = reply.getByRole("button", { name: "Resume", exact: true })
    if (await button.isVisible()) await button.click()
    else await messageMenu(reply, /^Resume/)
  }

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      test(`resume and step edits at ${width} ${theme}`, async ({ page }, info) => {
        test.setTimeout(180_000)
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme })
        await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const shot = async (name: string) => {
          if (shots) {
            mkdirSync(shots, { recursive: true })
            await page.waitForTimeout(200)
            await page.screenshot({ path: resolve(shots, `${name}-${width}-${theme}.png`), animations: "disabled" })
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        }
        const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          Effect.gen(function* () {
            yield* api.SetDisplayPrefs({ prefs: { steps: "expanded" } })
            const connection = yield* api.CreateConnection({
              kind: "openai-chat",
              settings: {
                name: "Synthetic agent",
                baseUrl: provider.baseUrl,
                compat: {},
                cacheTtlS: null,
                maxConcurrent: null,
                presetOverrideRefId: null
              }
            })
            const model = yield* api.AddUserModel({ connectionId: connection.id, key: "agent-small", overrides: {} })
            yield* api.SetGenerationDefaults({
              defaults: { model: { connection: connection.id, model: model.id }, preset: null }
            })
            const chat = yield* api.CreateChat({ title: `Resume ${width} ${theme}` })
            yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "AgentEnabled", on: true } })
            const sent = yield* api.SendMessage({
              chatId: chat.id,
              parentSlotId: null,
              branch: false,
              content: "Is the bridge still standing?"
            })
            if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
            return chat
          })
        )
        const replyButton = () => page.getByRole("button", { name: /^(Reply$|Generate(?! another))/ }).last()
        await page.goto(`${server().url}/chats/${chat.id}`)
        await expect(page.getByTestId("messages").getByText("Is the bridge still standing?")).toBeVisible()

        // Stopped after its first call: the reply keeps its step and offers Resume.
        provider.hold(1)
        await replyButton().click()
        const reply = page.getByRole("article").last()
        await expect(reply.locator('[data-step-status="done"]')).toHaveCount(1)
        await expect.poll(() => provider.heldCount()).toBeGreaterThan(0)
        await reply.getByRole("button", { name: "Stop", exact: true }).click()
        await expect(reply.getByText("stopped", { exact: true })).toBeVisible()
        await reveal(reply)
        await shot("resume-stopped")
        await expectLayout(page, info, `resume-stopped-${width}-${theme}`, { scope: "article:last-of-type" })

        // Resume: a new version, written live; the run waits at the same request.
        const sentBefore = provider.bodies.length
        await resume(reply)
        await expect(reply.locator('[data-steps-panel="running"]')).toBeVisible()
        await expect.poll(() => provider.bodies.length).toBeGreaterThan(sentBefore)
        const resumedFirst = provider.bodies[sentBefore]!
        expect(resumedFirst.messages.filter((m) => m.role === "tool")).toHaveLength(1)
        expect(resumedFirst.messages.at(-1)?.role).toBe("tool")
        // Reload restores the selected, live resumed version from this chat URL.
        await page.reload()
        await expect(reply.locator('[data-steps-panel="running"]')).toBeVisible()

        // The stopped version, shown again while its resume runs, can't be resumed twice.
        if (width >= 640) await showActions(reply)
        await reply.getByRole("button", { name: "Previous version" }).click()
        await expect(reply.getByText("stopped", { exact: true })).toBeVisible()
        await resume(reply)
        await expect(reply.getByText("This reply can't be carried on: it's already being resumed.")).toBeVisible()
        await shot("resume-refused")
        await expectLayout(page, info, `resume-refused-${width}-${theme}`, { scope: "article:last-of-type" })
        if (width >= 640) await showActions(reply)
        await reply.getByRole("button", { name: /^Next version/ }).click()
        // Stop a resumed reply, then resume that version: neither changes its frozen prefix.
        await reply.getByRole("button", { name: "Stop", exact: true }).click()
        await expect(reply.getByText("stopped", { exact: true })).toBeVisible()
        const nestedFrom = provider.bodies.length
        await resume(reply)
        await expect.poll(() => provider.bodies.length).toBeGreaterThan(nestedFrom)
        expect(provider.bodies[nestedFrom]!.messages).toEqual(resumedFirst.messages)
        provider.release()
        await expect(reply).toContainText(AGENT_REPLY)
        await expect(reply.locator("[data-steps-badge]")).toHaveText(/^2 steps · /)

        // A request that failed: the failed reply resumes the same way.
        await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          Effect.gen(function* () {
            const path = yield* api.ReadPath({
              chatId: chat.id,
              leafSlotId: null,
              range: { _tag: "Bottom" },
              limit: 10
            })
            const sent = yield* api.SendMessage({
              chatId: chat.id,
              parentSlotId: path.entries.at(-1)!.slotId as SlotId,
              branch: false,
              content: "And the lantern?"
            })
            if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
          })
        )
        await expect(page.getByTestId("messages").getByText("And the lantern?")).toBeVisible()
        provider.fail(1)
        await replyButton().click()
        const failed = page.getByRole("article").last()
        await expect(failed.getByText(/^Failed \(/)).toBeVisible()
        await reveal(failed)
        await shot("resume-failed")
        await expectLayout(page, info, `resume-failed-${width}-${theme}`, { scope: "article:last-of-type" })
        await resume(failed)
        await expect(failed).toContainText(AGENT_REPLY)
        await expect(failed.getByText(/^Failed \(/)).toHaveCount(0)

        // The run inspector: what the resume cut is folded; a call's result is edited and resumed from.
        await failed.locator("[data-steps-badge]").click()
        await failed.locator("[data-steps-panel]").getByRole("link", { name: "Open the run" }).click()
        const steps = page.getByRole("region", { name: "Steps", exact: true })
        await expect(steps.locator('[data-run-cut="resume"]')).toContainText("Cut when this reply was resumed")
        const result = steps.getByRole("region", { name: "Result of search_chat" }).first()
        await expect(result.getByRole("button", { name: "Resume from here" })).toBeVisible()
        await result.getByRole("button", { name: "Edit", exact: true }).click()
        const editor = result.locator('.cm-content[aria-label="Edit Result of search_chat"]')
        await expect(editor).toBeVisible()
        await editor.fill(EDITED)
        await expect(page).toHaveURL(/stepEdit=/)
        // The edit is on the server, and reloading restores the open editor and its text.
        await expect
          .poll(() =>
            asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
              Effect.gen(function* () {
                const me = yield* api.Whoami()
                const versionId = new URL(page.url()).pathname.split("/").at(-1)!
                const field = JSON.parse(new URL(page.url()).searchParams.get("stepEdit")!) as string
                return (yield* api.GetUserDraft({ ownerId: me.id, targetId: `run-step:${versionId}`, field }))?.content
              })
            )
          )
          .toBe(EDITED)
        await page.reload()
        await expect(editor).toHaveText(EDITED)
        await result.scrollIntoViewIfNeeded()
        await shot("step-edit")
        await expectLayout(page, info, `step-edit-${width}-${theme}`, { scope: '[aria-label="Steps"]' })
        const editedFrom = provider.bodies.length
        await result.getByRole("button", { name: "Resume", exact: true }).click()

        // The chat shows the new version being written; the model is sent the edited result.
        await expect(page).toHaveURL(new RegExp(`/chats/${chat.id}\\?`))
        const latest = page.getByRole("article").last()
        await expect(latest).toContainText(AGENT_REPLY)
        const editedSent = provider.bodies.slice(editedFrom)
        expect(editedSent.length).toBeGreaterThan(0)
        expect(JSON.stringify(editedSent[0]!.messages.at(-1))).toContain(EDITED)

        // Its inspector: the edited result, and what the edit cut, folded until opened.
        await latest.locator("[data-steps-badge]").click()
        await latest.locator("[data-steps-panel]").getByRole("link", { name: "Open the run" }).click()
        await expect(steps.getByRole("region", { name: "Result of search_chat" }).first()).toContainText(EDITED)
        const cut = steps.locator('[data-run-cut="edit"]')
        await expect(cut).toContainText("Cut when this step was edited")
        await expect(cut.getByRole("region", { name: "Result of search_chat" }).first()).toBeHidden()
        await cut.getByText("Cut when this step was edited").click()
        await expect(cut.getByRole("region", { name: "Result of search_chat" }).first()).toBeVisible()
        await expect(cut.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0)
        await cut.scrollIntoViewIfNeeded()
        await shot("step-cut")
        await expectLayout(page, info, `step-cut-${width}-${theme}`, { scope: '[aria-label="Steps"]' })
      })
    }
}

// The summary screens (DESIGN §8.1, ARCHITECTURE §16) against the production server, with
// summaries written by fixtures as the summarizer would have: the divider where verbatim
// history starts, the panel it opens (edit through a draft, revisions, asking for a summary
// again), the distinct marks on summarized, dropped and hidden messages, the coverage rail,
// the chat setting, and the context view. Each viewport runs the same flows.
import type { ChatId, ForkId, PathEntry } from "@rp/shared/chat.ts"
import type { SendResult } from "@rp/shared/chatApi.ts"
import type { VersionId } from "@rp/shared/chat.ts"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, serverPerFile, withAdmin } from "./support/server.ts"
import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { condensed, count, failedJob, level1 } from "./support/summaries.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { makeCopy } from "../src/features/editor/backup.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let cookie: string

const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)

test.beforeAll(async () => {
  provider = await startProvider()
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  await admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local model server",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-lcm-test-key-0042"
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

const signIn = async (page: Page) => {
  const [name, ...value] = cookie.split("=")
  await page.context().addCookies([{ name: name!, value: value.join("="), url: server().url }])
}

interface Fixture {
  readonly forkId: ForkId
  readonly chatId: ChatId
  readonly entries: ReadonlyArray<PathEntry>
  /** Messages 1–4 and 5–8, and the level-2 summary over both. */
  readonly first: { readonly id: string; readonly revisionId: string }
  readonly second: { readonly id: string }
  readonly top: { readonly id: string; readonly revisionId: string }
}

/** A chat of twelve messages, the first eight summarized: two level-1 summaries and a level 2. */
const makeChat = async (title: string): Promise<Fixture> => {
  const { chatId, forkId, entries } = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title })
      let parent: PathEntry["slotId"] | null = null
      for (let n = 1; n <= 12; n++) {
        const sent: SendResult = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content: `Message ${n} of the ${title}.`
        })
        if (sent._tag !== "Posted") return yield* Effect.die(new Error("the message was queued"))
        parent = sent.entry.slotId
      }
      const window = yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 100
      })
      return { chatId: chat.id, forkId: window.forkId!, entries: window.entries }
    })
  )
  const dataDir = server().dataDir
  const first = await level1(dataDir, chatId, entries.slice(0, 4), "The harbor was flooded and the road closed.")
  const second = await level1(dataDir, chatId, entries.slice(4, 8), "Mira found the ledger and kept it dry.")
  const top = await condensed(dataDir, chatId, [first, second], "A flood closed the road; Mira saved the ledger.")
  return { chatId, forkId, entries, first, second, top }
}

const requested = async (fixture: Fixture) => {
  const position = { chatId: fixture.chatId, forkId: fixture.forkId, leafSlotId: fixture.entries.at(-1)!.slotId }
  const coverage = await admin((api) =>
    api.GetLcmCoverage({ ...position, fromDepth: 0, toDepth: fixture.entries.length })
  )
  const state = await admin((api) => api.GetLcmState(position))
  return coverage.summaries.filter((s) => s.rerun).length + state.jobs.filter((j) => j.rerun).length
}

const open = async (page: Page, fixture: Fixture, search = "") => {
  await signIn(page)
  await page.goto(`${server().url}/chats/${fixture.chatId}${search}`)
  // Opened at a message, the divider may be off screen.
  if (search === "") await expect(page.getByTestId("lcm-boundary")).toBeVisible()
}

const article = (page: Page, fixture: Fixture, n: number) =>
  page.locator(`article[data-slot="${fixture.entries[n - 1]!.slotId}"]`)

const panel = (page: Page) => page.getByRole("tabpanel", { name: "Summaries" })

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["phone", { width: 390, height: 844 }]
] as const) {
  test.describe(name, () => {
    test.use({ viewport })

    test("the divider sits where verbatim history starts, and the messages above it are marked summarized", async ({
      page
    }) => {
      const fixture = await makeChat(`divider-${name}`)
      await open(page, fixture)
      const boundary = page.getByTestId("lcm-boundary")
      await expect(boundary).toContainText("Older messages: 1 summary")
      // After message 8 and before message 9.
      await expect(article(page, fixture, 9)).toBeVisible()
      const [above, line, below] = await Promise.all([
        article(page, fixture, 8).boundingBox(),
        boundary.boundingBox(),
        article(page, fixture, 9).boundingBox()
      ])
      expect(line!.y).toBeGreaterThanOrEqual(above!.y + above!.height - 1)
      expect(line!.y + line!.height).toBeLessThanOrEqual(below!.y + 1)
      await expect(article(page, fixture, 8)).toHaveAttribute("data-summarized", "true")
      await expect(article(page, fixture, 9)).not.toHaveAttribute("data-summarized")
      await expect(article(page, fixture, 8).getByRole("img", { name: /^Summarized/ })).toBeVisible()
      await expect(article(page, fixture, 8).getByText("Summarized", { exact: true })).toBeVisible()
    })

    test("summarized, dropped out of context and hidden messages look different", async ({ page }) => {
      const fixture = await makeChat(`marks-${name}`)
      // Message 3 is hidden on purpose, as SillyTavern's ghost does: it keeps the hidden mark only.
      await admin((api) =>
        api.SetMessageHidden({ slotId: fixture.entries[2]!.slotId, forkId: fixture.forkId, hidden: true })
      )
      await open(page, fixture, `?slot=${fixture.entries[1]!.slotId}`)
      const summarized = article(page, fixture, 2)
      await expect(summarized.getByRole("img", { name: /^Summarized/ })).toBeVisible()
      await expect(summarized.getByRole("img", { name: "Hidden from context", exact: true })).toHaveCount(0)
      await expect(summarized.getByRole("img", { name: "Not in the context", exact: true })).toHaveCount(0)
      await expect(summarized).not.toHaveClass(/border-dashed/)
      await expect(summarized).toHaveClass(/border-l-4/)
      const hidden = article(page, fixture, 3)
      await expect(hidden.getByRole("img", { name: "Hidden from context", exact: true })).toBeVisible()
      await expect(hidden.getByRole("img", { name: /^Summarized/ })).toHaveCount(0)
      await expect(hidden).not.toHaveAttribute("data-summarized")
      await expect(hidden).not.toHaveClass(/border-l-4|border-dashed/)
    })

    test("the panel lists the summaries by level and range; a range opens at its first message", async ({ page }) => {
      const fixture = await makeChat(`panel-${name}`)
      await open(page, fixture)
      await page.getByTestId("lcm-boundary").click()
      const dialog = panel(page)
      await expect(dialog).toBeVisible()
      const row = dialog.locator(`[data-summary="${fixture.top.id}"]`)
      await expect(row).toContainText("Level 2")
      await expect(row).toContainText("Messages 1–8")
      await expect(row).toContainText("A flood closed the road; Mira saved the ledger.")
      // Its children, a level down.
      await row.getByRole("button", { name: /Condensed from 2/ }).click()
      const children = row.getByRole("list", { name: /Summaries condensed into level 2/ })
      await expect(children).toContainText("Messages 1–4")
      await expect(children).toContainText("Messages 5–8")
      // A range scrolls to its first message.
      await children.getByRole("button", { name: "Messages 5–8" }).click()
      // Beside the chat the panel stays open; a phone's sheet closes to show the message.
      if (name === "phone") await expect(dialog).toHaveCount(0)
      else await expect(dialog).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`slot=${fixture.entries[4]!.slotId}`))
      await expect(article(page, fixture, 5)).toHaveClass(/border-accent/)
    })

    test("an edit goes through a draft and becomes a revision; any revision can be used again", async ({ page }) => {
      const fixture = await makeChat(`edit-${name}`)
      await open(page, fixture)
      await page.getByTestId("lcm-boundary").click()
      const dialog = panel(page)
      const row = dialog.locator(`[data-summary="${fixture.top.id}"]`)
      await row.getByRole("button", { name: /Edit the summary of messages 1–8/ }).click()
      const box = dialog.getByRole("textbox", { name: /Text of the summary of messages 1–8/ })
      await expect(box).toHaveValue("A flood closed the road; Mira saved the ledger.")
      await box.fill("The road flooded. Mira saved the ledger.")
      await expect(dialog.getByText("Your text is kept as a draft.")).toBeVisible()
      // The draft is on the server: a reload offers it again, with the panel still open at it.
      await page.reload()
      await expect(dialog).toBeVisible()
      await row.getByRole("button", { name: /Edit the summary of messages 1–8/ }).click()
      await expect(box).toHaveValue("The road flooded. Mira saved the ledger.")
      await dialog.getByRole("button", { name: "Save revision" }).click()
      await expect(row).toContainText("The road flooded. Mira saved the ledger.")
      await expect(row.getByText("Edited", { exact: true })).toBeVisible()
      // Revisions: the first is one click away.
      await row.getByRole("button", { name: /Revisions of the summary of messages 1–8/ }).click()
      const revisions = row.getByRole("list", { name: "Revisions" })
      await expect(revisions.getByRole("listitem")).toHaveCount(2)
      await row.getByRole("button", { name: "Use revision 1" }).click()
      await expect(row.getByText("Edited", { exact: true })).toHaveCount(0)
      await expect(row.getByText("A flood closed the road; Mira saved the ledger.").first()).toBeVisible()
    })

    test("a stale summary is marked; re-summarize only queues it for the next reply", async ({ page }) => {
      const fixture = await makeChat(`stale-${name}`)
      await open(page, fixture)
      await expect(page.getByTestId("lcm-boundary")).not.toContainText("stale")
      const jobs = await count(server().dataDir, "summarization_jobs")
      const requests = provider.completions.length
      // The user edits message 3 (a human message amends in place).
      await admin((api) =>
        api.AmendVersion({
          versionId: fixture.entries[2]!.version.id as VersionId,
          content: "Message 3, rewritten.",
          expectedRowVersion: 1
        })
      )
      await expect(page.getByTestId("lcm-boundary")).toContainText("1 stale")
      await page.getByTestId("lcm-boundary").click()
      // The fresh summary of 5–8 stands at the end, so the stale one over 1–4 is the one shown.
      const row = panel(page).locator(`[data-summary="${fixture.first.id}"]`)
      await expect(row.getByText("Stale", { exact: true })).toBeVisible()
      await row.getByRole("button", { name: /^Re-summarize messages 1–4 with the next reply/ }).click()
      await expect(row.getByText("Re-summarizes with the next reply")).toBeVisible()
      await expect(page.getByTestId("lcm-boundary")).toContainText("1 to redo")
      // Nothing was started: no job, no request to the provider.
      await page.waitForTimeout(1000)
      expect(await count(server().dataDir, "summarization_jobs")).toBe(jobs)
      expect(provider.completions.length).toBe(requests)
      expect(await requested(fixture)).toBe(1)
      await row.getByRole("button", { name: /^Cancel re-summarizing messages 1–4/ }).click()
      await expect(row.getByText("Re-summarizes with the next reply")).toHaveCount(0)
      expect(await requested(fixture)).toBe(0)
    })

    test("a job that gave up is shown as failed and can be asked to retry with the next reply", async ({ page }) => {
      const fixture = await makeChat(`failed-${name}`)
      await failedJob(server().dataDir, fixture.chatId, fixture.entries.slice(8, 11), "The model refused three times.")
      await open(page, fixture)
      await expect(page.getByTestId("lcm-boundary")).toContainText("1 failed")
      await page.getByTestId("lcm-boundary").click()
      const jobs = panel(page).getByRole("list", { name: "Work in progress" })
      await expect(jobs).toContainText("Messages 9–11 could not be summarized")
      await expect(jobs).toContainText("The model refused three times.")
      await jobs.getByRole("button", { name: /^Retry messages 9–11 with the next reply/ }).click()
      await expect(jobs.getByText("Retries with the next reply")).toBeVisible()
      expect(await requested(fixture)).toBeGreaterThan(0)
    })

    test("the coverage rail draws a bar per summary by level; stale ones are marked; a click opens the summary", async ({
      page
    }) => {
      const fixture = await makeChat(`rail-${name}`)
      await open(page, fixture)
      await expect(page.getByTestId("coverage-rail")).toHaveCount(0)
      await (await openPanel(page, "Summaries")).getByRole("switch", { name: /Coverage rail/ }).click()
      await closePanel(page)
      const rail = page.getByTestId("coverage-rail")
      await expect(rail.getByRole("button")).toHaveCount(3)
      await expect(rail.locator('[data-level="1"]')).toHaveCount(2)
      await expect(rail.locator('[data-level="2"]')).toHaveCount(1)
      // The level-2 bar spans both level-1 bars, which stand beside it a lane in.
      const [one, two, wide] = await Promise.all([
        rail.locator('[data-level="1"]').nth(0).boundingBox(),
        rail.locator('[data-level="1"]').nth(1).boundingBox(),
        rail.locator('[data-level="2"]').boundingBox()
      ])
      expect(wide!.x).toBeGreaterThan(one!.x)
      expect(wide!.y).toBeLessThanOrEqual(one!.y + 1)
      expect(wide!.y + wide!.height).toBeGreaterThanOrEqual(two!.y + two!.height - 1)
      // It is a choice of this browser: it stays across a reload.
      await page.reload()
      await expect(page.getByTestId("coverage-rail")).toBeVisible()
      // A summary in a lower level, not in use: its click opens the panel at it.
      await page.getByTestId("coverage-rail").locator('[data-level="1"]').nth(1).click()
      const dialog = panel(page)
      await expect(dialog.locator(`[data-summary="${fixture.second.id}"]`)).toContainText("Mira found the ledger")
      await closePanel(page)
      // A stale message makes the bars over it hatched.
      await admin((api) =>
        api.AmendVersion({
          versionId: fixture.entries[5]!.version.id as VersionId,
          content: "Message 6, rewritten.",
          expectedRowVersion: 1
        })
      )
      await expect(page.getByTestId("coverage-rail").getByRole("button", { name: /stale/ })).toHaveCount(2)
      await (await openPanel(page, "Summaries")).getByRole("switch", { name: /Coverage rail/ }).click()
      await expect(page.getByTestId("coverage-rail")).toHaveCount(0)
    })

    test("LCM is a switch in the chat's side panel", async ({ page }) => {
      const fixture = await makeChat(`switch-${name}`)
      await open(page, fixture)
      const settings = await openPanel(page, "This chat")
      const toggle = settings.getByRole("switch", { name: /Summarize older messages/ })
      await expect(toggle).toBeChecked()
      await toggle.click()
      await expect(toggle).not.toBeChecked()
      await expect(page.getByTestId("lcm-boundary")).toHaveCount(0)
      await expect(article(page, fixture, 8)).not.toHaveAttribute("data-summarized")
      await expect((await openPanel(page, "Summaries")).getByText("Summaries are off for this chat.")).toBeVisible()
      await (await openPanel(page, "This chat")).getByRole("switch", { name: /Summarize older messages/ }).click()
      // Turning it on for a chat with messages asks how to start and what it costs first.
      const enable = page.getByRole("dialog", { name: "Summarize older messages" })
      await expect(
        enable.getByRole("group", { name: "Estimate" }).or(enable.getByText("Nothing needs summarizing"))
      ).toBeVisible()
      await enable.getByRole("button", { name: "Enable summaries" }).click()
      await expect(enable).toHaveCount(0)
      await closePanel(page)
      await expect(page.getByTestId("lcm-boundary")).toBeVisible()
      await expect(article(page, fixture, 8)).toHaveAttribute("data-summarized", "true")
    })

    test("the refusal judge and the fallback summarizer are chosen in Settings → Chats and kept", async ({ page }) => {
      const fixture = await makeChat(`models-${name}`)
      // Whatever an earlier run chose: none.
      await admin((api) =>
        Effect.gen(function* () {
          const now = yield* api.GetGenerationDefaults()
          yield* api.SetGenerationDefaults({ defaults: { model: now.model, preset: now.preset, judge: null, lcm: {} } })
        })
      )
      await open(page, fixture)
      // For all chats, so not in the chat's panel: it links there.
      await (await openPanel(page, "This chat")).getByRole("link", { name: "Settings → Chats" }).last().click()
      await expect(page).toHaveURL(/\/settings\/chats$/)
      const dialog = page.getByRole("region", { name: "Models for summaries" })
      const pick = async (select: Locator, option: string | RegExp) => {
        await select.click()
        await page.getByRole("listbox").getByRole("option", { name: option }).click()
        await expect(page.getByRole("listbox")).toHaveCount(0)
      }
      await pick(dialog.getByLabel("Refusal judge"), /fake-small/)
      await pick(dialog.getByLabel("Fallback summarizer"), /fake-small/)
      await expect
        .poll(async () => admin((api) => api.GetGenerationDefaults()).then((d) => [!!d.judge, !!d.lcm?.fallback]))
        .toEqual([true, true])
      await pick(dialog.getByLabel("Refusal judge"), "None")
      await expect.poll(async () => admin((api) => api.GetGenerationDefaults()).then((d) => !!d.judge)).toBe(false)
      // Clearing one leaves the other.
      expect(await admin((api) => api.GetGenerationDefaults()).then((d) => !!d.lcm?.fallback)).toBe(true)
    })

    test("a reply a judge found refused is marked and can be retried with another model", async ({ page }) => {
      const fixture = await makeChat(`retry-${name}`)
      const reply = await admin((api) =>
        api.Generate({ chatId: fixture.chatId, parentSlotId: fixture.entries.at(-1)!.slotId, branch: false })
      )
      if (reply._tag !== "Posted") throw new Error("the reply was queued")
      await open(page, fixture)
      await expect(page.getByRole("article", { name: "Reply" }).getByText("The bridge holds.")).toBeVisible()
      await expect(page.getByText("Retry with…")).toHaveCount(0)
      await Effect.runPromise(
        fixtureSql(server().dataDir, [
          { sql: "UPDATE versions SET mark = 'refused' WHERE id = ?", params: [reply.entry.version.id] }
        ])
      )
      await page.reload()
      const article = page.getByRole("article", { name: "Reply" })
      await expect(article.getByText("refused", { exact: true })).toBeVisible()
      const before = provider.completions.length
      await article.getByText("Retry with…").click()
      await page.getByRole("option", { name: /fake-small/ }).click()
      await expect.poll(() => provider.completions.length).toBeGreaterThan(before)
    })

    test("the context view names a summary source with its level, range and revision", async ({ page }) => {
      const fixture = await makeChat(`context-${name}`)
      const reply = await admin((api) =>
        api.Generate({ chatId: fixture.chatId, parentSlotId: fixture.entries.at(-1)!.slotId, branch: false })
      )
      if (reply._tag !== "Posted") throw new Error("the reply was queued")
      await open(page, fixture)
      await expect(page.getByRole("article", { name: "Reply" }).getByText("The bridge holds.")).toBeVisible()
      await page.goto(`${server().url}/chats/${fixture.chatId}/context/${reply.entry.version.id}`)
      const messages = page.getByRole("region", { name: "Messages" })
      await expect(messages.getByText("Summary, level 2, messages 1–8, revision 1")).toBeVisible()
      // Edited since the reply was generated: the context says it changed.
      await admin((api) =>
        api.EditSummary({
          summaryId: fixture.top.id as never,
          content: "Edited afterwards.",
          expectedRowVersion: 1,
          commitDraft: null
        })
      )
      await page.reload()
      await expect(page.getByText("Summary stale or replaced since this reply.")).toBeVisible()
    })
  })
}

test("rail child rerun exposes cancel action", async ({ page }) => {
  const fixture = await makeChat("review-child-rerun")
  await open(page, fixture)
  await (await openPanel(page, "Summaries")).getByRole("switch", { name: /Coverage rail/ }).click()
  await page
    .getByTestId("coverage-rail")
    .getByRole("button", { name: /Level 1, messages 1–4/ })
    .click()
  const row = panel(page).locator(`[data-summary="${fixture.first.id}"]`)
  await row.getByRole("button", { name: /Re-summarize messages 1–4 with the next reply/ }).click()
  await expect.poll(() => requested(fixture)).toBe(1)
  await expect(row.getByRole("button", { name: /Cancel re-summarizing messages 1–4/ })).toBeVisible()
  await row.getByRole("button", { name: /Cancel re-summarizing messages 1–4/ }).click()
  await expect.poll(() => requested(fixture)).toBe(0)
  await expect(row.getByRole("button", { name: /Re-summarize messages 1–4 with the next reply/ })).toBeVisible()
  await admin((api) =>
    api.EditSummary({
      summaryId: fixture.first.id as never,
      content: "A revised child from another tab.",
      expectedRowVersion: 1,
      commitDraft: null
    })
  )
  await expect(row.getByText("A revised child from another tab.", { exact: true })).toBeVisible()
  await admin((api) =>
    api.EditSummary({
      summaryId: fixture.top.id as never,
      content: "My protected condensation.",
      expectedRowVersion: 1,
      commitDraft: null
    })
  )
  await expect(row.getByRole("button", { name: /Re-summarize messages 1–4 with the next reply/ })).toBeDisabled()
  await expect(
    row.getByText("Edit or re-summarize the covering summary to change this part of the context.")
  ).toBeVisible()
})

// A summary's edit keeps its text through the same races as every other field (ARCHITECTURE §3.10).
test.describe("the text of a summary's edit", () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  const editTop = async (page: Page, fixture: Fixture) => {
    await page.getByTestId("lcm-boundary").click()
    const dialog = panel(page)
    await dialog
      .locator(`[data-summary="${fixture.top.id}"]`)
      .getByRole("button", { name: /Edit the summary of messages 1–8/ })
      .click()
    return dialog
  }
  const box = (dialog: Locator) => dialog.getByRole("textbox", { name: /Text of the summary of messages 1–8/ })

  test("text typed while the revision is being saved stays in the edit", async ({ page }) => {
    const fixture = await makeChat("summary-typed-during-save")
    let release: (() => void) | null = null
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        if (typeof data === "string" && JSON.parse(data).tag === "EditSummary") release = () => upstream.send(data)
        else upstream.send(data)
      })
    })
    await open(page, fixture)
    const dialog = await editTop(page, fixture)
    const submitted = "The road flooded. Mira saved the ledger."
    const later = "The road flooded. Mira saved the ledger, and more typed while it was being saved."
    await box(dialog).fill(submitted)
    await expect(dialog.getByText("Your text is kept as a draft.")).toBeVisible()
    await dialog.getByRole("button", { name: "Save revision" }).click()
    await expect.poll(() => release !== null).toBe(true)
    await box(dialog).fill(later)
    release!()
    // The revision is what was submitted; the edit stays open with what was typed since.
    await expect
      .poll(async () => (await admin((api) => api.GetSummary({ summaryId: fixture.top.id as never }))).content)
      .toBe(submitted)
    await expect(box(dialog)).toHaveValue(later)
    await expect
      .poll(
        async () =>
          (await admin((api) => api.GetSummaryDraft({ forkId: fixture.forkId, summaryId: fixture.top.id as never })))
            ?.content
      )
      .toBe(later)
    // Typed on the revision just saved: the draft isn't marked as started from an older one.
    await expect(dialog.getByText("The draft started from an older revision")).toHaveCount(0)
  })

  test("text replayed from this browser that the server refused is retried on the draft it was typed on", async ({
    page
  }) => {
    const fixture = await makeChat("summary-replay-retried")
    const summaryId = fixture.top.id as never
    const first = await admin((api) =>
      api.SaveSummaryDraft({
        forkId: fixture.forkId,
        summaryId,
        draftId: null,
        content: "A flood closed the road; Mira saved the ledger. Shared.",
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: fixture.top.revisionId as never
      })
    )
    let fail = true
    const sent: Array<{ expectedRowVersion: number | null }> = []
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        const request =
          typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: string; payload?: never }) : null
        if (request?.tag === "SaveSummaryDraft") {
          sent.push(request.payload!)
          if (fail) {
            fail = false
            const error = { _tag: "ServerError", message: "Synthetic transient failure" }
            const exit = { _tag: "Failure", cause: [{ _tag: "Fail", error }] }
            socket.send(JSON.stringify({ _tag: "Exit", requestId: request.id, exit }))
            return
          }
        }
        upstream.send(data)
      })
    })
    await open(page, fixture)
    // This browser kept text typed on the first save; another device then saved a small change.
    const { id: me } = await admin((api) => api.Whoami())
    const offline = `${first.content} offline A`
    const copy = makeCopy(
      me,
      `${fixture.top.id}:${fixture.forkId}`,
      "summary",
      {
        kind: "summary",
        payload: {
          forkId: fixture.forkId,
          summaryId,
          draftId: first.id,
          content: offline,
          expectedRowVersion: first.rowVersion,
          expectedSession: first.session,
          baseRevisionId: fixture.top.revisionId as never
        }
      },
      Date.now()
    )
    await page.evaluate(
      (copy) =>
        new Promise<void>((resolve) => {
          const request = indexedDB.open("rp-editor-copies", 1)
          request.onupgradeneeded = () => {
            const store = request.result.createObjectStore("copies", { keyPath: "key" })
            store.createIndex("userId", "userId")
            store.createIndex("ref", ["userId", "refId"])
          }
          request.onsuccess = () => {
            const db = request.result
            const transaction = db.transaction("copies", "readwrite")
            transaction.objectStore("copies").put(copy)
            transaction.oncomplete = () => {
              db.close()
              resolve()
            }
          }
        }),
      copy
    )
    const elsewhere = `${first.content} other B`
    await admin((api) =>
      api.SaveSummaryDraft({
        forkId: fixture.forkId,
        summaryId,
        draftId: first.id,
        content: elsewhere,
        expectedRowVersion: first.rowVersion,
        expectedSession: first.session,
        baseRevisionId: fixture.top.revisionId as never
      })
    )
    // The replay fails once: the box shows this browser's text; more is typed and saved.
    const dialog = await editTop(page, fixture)
    await expect(box(dialog)).toHaveValue(offline)
    await box(dialog).fill(`${offline}!`)
    await expect
      .poll(async () => (await admin((api) => api.GetSummaryDraft({ summaryId, forkId: fixture.forkId })))?.content)
      .toBe(`${offline}!`)
    // Every attempt named the draft as this browser had it, not as the other device left it.
    expect(sent.map((payload) => payload.expectedRowVersion)).toEqual([first.rowVersion, first.rowVersion])
    await dialog.getByRole("button", { name: "Save revision" }).click()
    await expect(box(dialog)).toHaveCount(0)
    // The other device's text was one step back, and the revision sends it to the recovered texts.
    const recovered = await admin((api) => api.ListRecoveredTexts({ limit: 100, before: null }))
    expect(recovered.map((text) => text.content)).toContain(elsewhere)
  })
})

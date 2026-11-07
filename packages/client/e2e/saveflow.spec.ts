// Synthetic editors: one fixed header cluster, field recovery and nested tab state.
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { textField, valueField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { expectTextBox, replaceEditorText, textBoxValue } from "./support/textbox.ts"
import { editHistoryTexts, saveCluster, saveRevision } from "./support/saveRevision.ts"

const server = serverPerFile(withAdmin)
let adminCookie = ""
test.beforeAll(async () => {
  adminCookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), adminCookie, use)
const work = process.env.SAVEFLOW_WORK
const before = process.env.SAVEFLOW_BEFORE === "1"
const audit = process.env.SAVEFLOW_AUDIT === "1"
const preset = JSON.parse(
  readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
)

async function seed(page: Page, name: string) {
  const separator = adminCookie.indexOf("=")
  await page.context().addCookies([
    {
      name: adminCookie.slice(0, separator),
      value: adminCookie.slice(separator + 1),
      url: server().url,
      httpOnly: true
    }
  ])
  const upload = async (label: string, data: unknown) => {
    const response = await page.request.post(`${server().url}/library/import?name=${label}.json`, {
      data: Buffer.from(JSON.stringify(data)),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(response.ok()).toBe(true)
    return (await response.json()).library.ref as { id: RefId; entityId: string }
  }
  const card = await upload(`Card ${name}`, {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: `Wren ${name}`,
      description: "A keeper of the harbour light.",
      personality: "Patient and observant.",
      first_mes: "The lamp turns."
    }
  })
  const prompt = await upload(`Preset ${name}`, preset)
  const book = await upload(`Book ${name}`, {
    name: `Book ${name}`,
    entries: {
      0: { uid: 0, key: ["harbour"], comment: "Harbour", content: "Boats rock at the quay.", order: 10 }
    }
  })
  const chat = await admin((api) =>
    Effect.gen(function* () {
      yield* api.ChangeGenerationDefaults({ change: { preset: prompt.id } })
      const chat = yield* api.CreateChat({ title: name })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "Join", entityId: card.entityId as never }
      })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Lorebook", ref: book.id, active: true } })
      return chat
    })
  )
  return { card, preset: prompt, book, chat }
}

async function crop(page: Page, scope: Locator, name: string) {
  if (!work) return
  mkdirSync(work, { recursive: true })
  const title = name.startsWith("book-") ? scope.locator("[data-editor-header]").first() : scope
  await title.evaluate((el) => el.scrollIntoView({ block: "start", behavior: "instant" }))
  const box = await scope.boundingBox()
  const titleBox = await title.boundingBox()
  if (box)
    await page.screenshot({
      path: join(work, `${before ? "before" : "after"}-${name}.png`),
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, titleBox!.y),
        width: Math.min(box.width, page.viewportSize()!.width - Math.max(0, box.x)),
        height: Math.min(box.height, 250, page.viewportSize()!.height - Math.max(0, titleBox!.y))
      }
    })
}

for (const width of audit ? [390, 1024, 1440] : [1440])
  for (const theme of audit ? (["light", "dark"] as const) : (["light"] as const))
    for (const kind of ["card", "preset", "book"] as const)
      for (const large of [false, true])
        test(`${kind} ${large ? "large" : "panel"}: fixed save cluster (${width} ${theme})`, async ({ page }, info) => {
          test.setTimeout(180_000)
          await page.setViewportSize({ width, height: 1000 })
          await page.addInitScript((theme) => localStorage.setItem("rp.theme", theme), theme)
          const data = await seed(page, `${kind}-${large}-${width}-${theme}`)
          const tabName =
            kind === "card"
              ? `Wren ${kind}-${large}-${width}-${theme}`
              : kind === "preset"
                ? "Prompt preset"
                : "Lorebooks"
          await page.goto(`${server().url}/chats/${data.chat.id}${large ? `?editor=${data[kind].id}` : ""}`)
          let scope: Locator
          if (large)
            scope = page.getByRole("region", {
              name: kind === "card" ? "Card editor" : kind === "preset" ? "Preset editor" : "Lorebook editor",
              exact: true
            })
          else {
            scope = await openPanel(page, tabName)
            if (kind === "book")
              await scope.getByRole("button", { name: new RegExp(`^Book ${kind}-${large}-${width}-${theme}`) }).click()
          }
          await expect(saveCluster(scope)).toHaveCount(1)
          if (before) {
            await crop(page, scope, `${kind}-${large ? "large" : "panel"}-${width}-${theme}`)
            return
          }
          if (kind === "preset" && !large)
            await scope.getByRole("button", { name: "Expand Main Prompt", exact: true }).click()
          if (kind === "book") await scope.getByRole("button", { name: "Open Harbour", exact: true }).click()
          const field = scope
            .getByRole("textbox", {
              name: kind === "card" ? "Description" : kind === "preset" ? "Prompt: Main Prompt" : "Entry content",
              exact: true
            })
            .first()
          await expect(field).toBeVisible()
          await crop(page, scope, `${kind}-${large ? "large" : "panel"}-${width}-${theme}`)
          const cluster = saveCluster(scope)
          // DESIGN §10.1 centerheader: large-editor actions sit above the scroll area.
          const header = large
            ? scope.locator("[data-center-header]")
            : cluster.locator("xpath=ancestor::*[@data-editor-header][1]")
          await expect(header).toHaveCount(1)
          if (kind !== "card" && !large) {
            const expand = header.getByRole("link", {
              name: kind === "preset" ? "Open the preset in the large editor" : "Large editor",
              exact: true
            })
            await expect(expand).toBeVisible()
            await expect(header.locator("button, a").last()).toHaveAttribute(
              "aria-label",
              kind === "preset" ? "Open the preset in the large editor" : "Large editor"
            )
            const controls = (await cluster.boundingBox())!,
              at = (await expand.boundingBox())!
            expect(at.x - controls.x - controls.width).toBeGreaterThanOrEqual(0)
            expect(at.x - controls.x - controls.width).toBeLessThanOrEqual(8)
          }
          await header.evaluate((el) => el.scrollIntoView({ block: "start", behavior: "instant" }))
          const position = await cluster.boundingBox()
          const bounds = await header.boundingBox()
          // In a tab's header, Close, the split buttons and the panel's toggle follow it.
          expect(position!.x + position!.width).toBeGreaterThan(bounds!.x + bounds!.width - (large ? 200 : 100))
          if (large)
            expect(Math.abs(position!.y + position!.height / 2 - bounds!.y - bounds!.height / 2)).toBeLessThanOrEqual(1)
          else expect(Math.abs(position!.y - bounds!.y)).toBeLessThanOrEqual(4)
          for (const name of ["Save", "Save with message…", "Revert"]) {
            await expect(cluster.getByRole("button", { name, exact: true })).toBeDisabled()
            await expect(cluster.getByRole("button", { name, exact: true })).toHaveAccessibleDescription(
              "No changes since the last revision."
            )
          }
          const frame = scope
            .locator("[data-field-frame]")
            .filter({
              has: page.getByRole("textbox", {
                name: kind === "card" ? "Description" : kind === "preset" ? "Prompt: Main Prompt" : "Entry content",
                exact: true
              })
            })
            .first()
          const fieldRevert = frame.getByRole("button", { name: "Revert to last revision", exact: true })
          await expect(fieldRevert).toBeDisabled()
          await frame.hover()
          await fieldRevert.hover()
          await expect(
            page.getByText("Revert to last revision", { exact: true }).filter({ visible: true })
          ).toBeVisible()
          await page.mouse.move(0, 0)
          const original = await textBoxValue(field)
          await replaceEditorText(field, `${original}\nChanged for saveflow.`)
          for (const [name, hint] of [
            ["Save", "Save a revision: a version of this you can go back to from History."],
            ["Save with message…", "Save a revision with a note saying what changed."],
            ["Revert", "Revert to the last revision."]
          ] as const) {
            await expect(cluster.getByRole("button", { name, exact: true })).toBeEnabled()
            await expect(cluster.getByRole("button", { name, exact: true })).toHaveAccessibleDescription(hint)
          }
          await header.evaluate((el) => el.scrollIntoView({ block: "start", behavior: "instant" }))
          const dirtyPosition = await cluster.boundingBox()
          expect(dirtyPosition!.width).toBe(position!.width)
          expect(dirtyPosition!.height).toBe(position!.height)
          expect(Math.abs(dirtyPosition!.x - position!.x)).toBeLessThanOrEqual(1)
          expect(Math.abs(dirtyPosition!.y - position!.y)).toBeLessThanOrEqual(1)
          const dot = scope.getByRole("tab", { name: "Definition", exact: true }).locator("[data-unsaved-dot]")
          if (kind === "card") await expect(dot).toBeVisible()
          if (!large) {
            const parent = page.getByRole("tab", { name: tabName, exact: true })
            await expect(parent).toHaveAttribute("data-unsaved", "true")
          }
          const personality = scope.getByRole("textbox", { name: "Personality", exact: true })
          if (kind === "card") await personality.fill("An independent field edit.")
          await frame.getByRole("button", { name: "Revert to last revision", exact: true }).click()
          await expectTextBox(field, original)
          if (kind === "card") await expectTextBox(personality, "An independent field edit.")
          if (kind !== "book") {
            await field.press("Control+z")
            await expectTextBox(field, `${original}\nChanged for saveflow.`)
            await frame.getByRole("button", { name: "Revert to last revision", exact: true }).click()
            await expectTextBox(field, original)
          }
          await expect(frame.getByRole("button", { name: "Revert to last revision", exact: true })).toBeDisabled()
          await replaceEditorText(field, `${original}\nA saved change.`)
          await saveRevision(scope)
          await expect(cluster.getByRole("status")).toHaveText("Revision saved.")
          if (kind === "card") await expect(dot).toHaveCount(0)
          const historyKey = textField(
            kind === "card"
              ? ["description"]
              : kind === "preset"
                ? ["prompts", "identifier=main", "content"]
                : ["entries", "uid=0", "content"]
          )
          const retained = await admin((api) => editHistoryTexts(api, data[kind].id, historyKey))
          expect(retained).toContain(`${original}\nChanged for saveflow.`)
          if (audit) {
            await header.scrollIntoViewIfNeeded()
            await scope.evaluate((el) => el.setAttribute("data-saveflow-audit", ""))
            await expectLayout(page, info, `${kind}-${large ? "large" : "panel"}-${width}-${theme}`, {
              scope: "[data-saveflow-audit]"
            })
            if (work && kind === "preset" && width === 1024)
              await scope.locator('[data-prompt="worldInfoBefore"]').screenshot({
                path: join(work, `after-preset-marker-${large ? "large" : "panel"}-${width}-${theme}.png`)
              })
          }
        })

for (const kind of ["card", "preset", "book"] as const)
  test(`large ${kind} edits mark a panel tab before its first visit`, async ({ page }) => {
    test.skip(before || audit, "covered by the functional editor checks")
    await page.setViewportSize({ width: 1440, height: 1000 })
    const data = await seed(page, `unvisited-${kind}`)
    await page.goto(`${server().url}/chats/${data.chat.id}?panel=chat&editor=${data[kind].id}`)
    const scope = page.getByRole("region", {
      name: kind === "card" ? "Card editor" : kind === "preset" ? "Preset editor" : "Lorebook editor",
      exact: true
    })
    if (kind === "book") await scope.getByRole("button", { name: "Open Harbour", exact: true }).click()
    await replaceEditorText(
      scope
        .getByRole("textbox", {
          name: kind === "card" ? "Description" : kind === "preset" ? "Prompt: Main Prompt" : "Entry content",
          exact: true
        })
        .first(),
      "Changed in the large editor."
    )
    const name = kind === "card" ? "Wren unvisited-card" : kind === "preset" ? "Prompt preset" : "Lorebooks"
    // The side panel's tab, not the workbench's tab of the same name.
    const tab = page.getByRole("complementary", { name: "Chat panel" }).getByRole("tab", { name, exact: true })
    if (await tab.isVisible()) await expect(tab.locator("[data-unsaved-dot]")).toBeVisible()
    else
      await expect(
        page.getByRole("button", { name: "More tools", exact: true }).locator("[data-unsaved-dot]")
      ).toBeVisible()
    await saveRevision(scope)
    await expect(tab.locator("[data-unsaved-dot]")).toHaveCount(0)
  })

test("a greeting revert keeps its sibling and its replaced text in history", async ({ page }) => {
  test.skip(before || audit, "covered by functional checks")
  const data = await seed(page, "greeting-history")
  const base = await admin((api) => api.OpenEditor({ refId: data.card.id }))
  await admin((api) =>
    Effect.gen(function* () {
      const draft = yield* api.SaveEditorDraft({
        refId: data.card.id,
        field: '=["alternate_greetings"]',
        draftId: null,
        expectedSession: null,
        expectedRowVersion: null,
        baseRevisionId: base.ref.headRevisionId,
        content: JSON.stringify(["First greeting.", "Second greeting."])
      })
      yield* api.CommitEditorDrafts({
        refId: data.card.id,
        expectedRowVersion: base.ref.rowVersion,
        fields: [{ field: draft.key.field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
        message: null
      })
    })
  )
  await page.goto(`${server().url}/library/${data.card.id}`)
  await page.getByRole("tab", { name: "Greetings", exact: true }).click()
  const first = page.getByRole("textbox", { name: "Alternate greeting 1", exact: true })
  const second = page.getByRole("textbox", { name: "Alternate greeting 2", exact: true })
  await first.fill("First changed.")
  await second.fill("Second changed.")
  await page
    .locator("[data-field-frame]")
    .filter({ has: page.getByRole("textbox", { name: "Alternate greeting 1", exact: true }) })
    .getByRole("button", { name: "Revert to last revision", exact: true })
    .click()
  await expectTextBox(first, "First greeting.")
  await expectTextBox(second, "Second changed.")
  await saveRevision(page)
  const states = await admin((api) => editHistoryTexts(api, data.card.id, '=["alternate_greetings"]'))
  expect(states.filter((text) => text.startsWith("[")).map((text) => JSON.parse(text))).toContainEqual([
    "First changed.",
    "Second changed."
  ])
})

test("typing while a field revert is in flight stays visible and saves", async ({ page }) => {
  test.skip(before || audit, "covered by functional checks")
  const data = await seed(page, "revert-race")
  let release: (() => void) | undefined
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((message) => {
      if (typeof message === "string" && message.includes('"RestoreEditorDraft"')) {
        release = () => upstream.send(message)
        return
      }
      upstream.send(message)
    })
    upstream.onMessage((message) => socket.send(message))
  })
  await page.goto(`${server().url}/library/${data.card.id}`)
  const field = page.getByRole("textbox", { name: "Description", exact: true })
  await field.fill("Before the revert.")
  await page
    .locator("[data-field-frame]")
    .filter({ has: page.getByRole("textbox", { name: "Description", exact: true }) })
    .getByRole("button", { name: "Revert to last revision", exact: true })
    .click()
  await expect.poll(() => release !== undefined).toBe(true)
  await field.fill("Newer typing during the revert.")
  release!()
  await expectTextBox(field, "Newer typing during the revert.")
  await saveRevision(page)
  await page.reload()
  await expectTextBox(
    page.getByRole("textbox", { name: "Description", exact: true }),
    "Newer typing during the revert."
  )
})

test("a copied entry's first field revert retains the copied text", async ({ page }) => {
  test.skip(before || audit, "covered by functional checks")
  const data = await seed(page, "copied-entry")
  await page.goto(`${server().url}/library/${data.book.id}`)
  await page.getByRole("button", { name: "More for Harbour", exact: true }).click()
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click()
  const entry = page
    .getByRole("group", { name: /^Lorebook entry/ })
    .filter({ has: page.getByRole("textbox", { name: "Title of Harbour (copy)", exact: true }) })
  const content = entry.getByRole("textbox", { name: "Entry content", exact: true })
  await expect(content).toHaveValue("Boats rock at the quay.")
  const frame = entry
    .locator("[data-field-frame]")
    .filter({ has: page.getByRole("textbox", { name: "Entry content", exact: true }) })
  await frame.getByRole("button", { name: "Revert to last revision", exact: true }).click()
  await expect(content).toHaveValue("")
  await entry
    .locator("span[data-own-click]")
    .filter({ hasText: /^harbour$/ })
    .click()
  const keys = entry.getByRole("textbox", { name: "Primary keys", exact: true })
  await entry
    .locator("[data-field-frame]")
    .filter({ has: page.getByRole("textbox", { name: "Primary keys", exact: true }) })
    .getByRole("button", { name: "Revert to last revision", exact: true })
    .click()
  await expect(keys).toHaveValue("")
  await saveRevision(page)
  const saved = await admin((api) => api.OpenEditor({ refId: data.book.id }))
  const copy = (saved.doc.entries as Array<{ uid: number; comment: string }>).find(
    (item) => item.comment === "Harbour (copy)"
  )!
  const texts = await admin((api) =>
    editHistoryTexts(api, data.book.id, textField(["entries", `uid=${copy.uid}`, "content"]))
  )
  expect(texts).toContain("Boats rock at the quay.")
  const keyStates = await admin((api) =>
    editHistoryTexts(api, data.book.id, valueField(["entries", `uid=${copy.uid}`, "keys"]))
  )
  expect(keyStates).toContain(JSON.stringify(["harbour"]))
})

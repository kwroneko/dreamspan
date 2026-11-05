// Merging a parent's changes into a library fork (DESIGN §4, ARCHITECTURE §14.6), in a real
// browser against the real server: the notice in the full and side-panel editors, the review
// with its per-prompt/entry/field choices and explicit conflicts, unsaved fields refused with
// Save/Revert, a historical parent revision, Undo merge in History, a card's file Merge, the
// family tree, a fork marked by hand. Every preset, lorebook and card here is made up.
import { mkdirSync } from "node:fs"
import { expect, type Locator, type Page, test, type TestInfo } from "@playwright/test"
import { Effect } from "effect"
import { book, draftField, importFile, saveField, seedPresetFork } from "./support/forkMerge.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = process.env.FORK_MERGE_ARTIFACTS

/** A screenshot (when asked for) and, under LAYOUT_AUDIT, the audit of that surface. */
const capture = async (page: Page, info: TestInfo, surface: Locator, name: string) => {
  if (shots) {
    mkdirSync(shots, { recursive: true })
    await surface.screenshot({ path: `${shots}/${name}.png` })
    await page.screenshot({ path: `${shots}/${name}-page.png` })
  }
  if (process.env.LAYOUT_AUDIT) {
    await surface.evaluate((el) => el.setAttribute("data-forkmerge-audit", ""))
    await expectLayout(page, info, name, { scope: "[data-forkmerge-audit]" })
    await surface.evaluate((el) => el.removeAttribute("data-forkmerge-audit"))
  }
}

const notice = (scope: Page | Locator) =>
  scope.getByRole("status").filter({ hasText: /The parent has \d+ new revisions?|newer imported version/ })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a preset fork merges its parent's changes and undoes the merge ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const { fork, parent } = await seedPresetFork(server(), ` ${width} ${theme}`)
      await page.goto(`${server().url}/library/${fork.id}`)

      const banner = notice(page)
      await expect(banner).toContainText("The parent has 2 new revisions")
      await capture(page, info, banner, `${width}-${theme}-notice`)
      const review = banner.getByRole("button", { name: "Review and merge", exact: true })
      await expect(review).toHaveAccessibleDescription(/parent's changes/)
      await review.click()
      const dialog = page.getByRole("dialog", { name: `Merge into ${fork.label}` })
      await expect(dialog.getByRole("link", { name: parent.label })).toHaveAttribute("href", `/library/${parent.id}`)
      const changes = dialog.getByRole("list", { name: "Changes to merge" })
      // The conflicting prompt first, then the clean change.
      const rows = changes.locator(":scope > li")
      await expect(rows).toHaveCount(2)
      await expect(rows.nth(0)).toContainText("conflict")
      await expect(rows.nth(1)).not.toContainText("conflict")
      const merge = dialog.getByRole("button", { name: "Merge", exact: true })
      await expect(merge).toBeDisabled()
      await expect(dialog.getByRole("status").filter({ hasText: "1 left" })).toBeVisible()
      await capture(page, info, dialog, `${width}-${theme}-review`)

      const conflict = rows.nth(0).getByRole("list", { name: /^Conflicts in/ })
      await expect(conflict).toContainText("at night")
      await expect(conflict).toContainText("in the harbour")
      await conflict.getByRole("radio", { name: "Take parent's version" }).check()
      await expect(merge).toBeEnabled()
      const result = dialog.getByRole("region", { name: `What merging changes in ${fork.label}` })
      await expect(result.locator("summary")).toHaveCount(2)
      await capture(page, info, dialog, `${width}-${theme}-review-resolved`)
      await merge.click()
      await expect(dialog).toHaveCount(0)
      await expect(notice(page)).toHaveCount(0)

      const revisions = await admin((api) => api.ListRevisions({ refId: fork.id, limit: 5 }))
      expect(revisions[0]!.origin).toBe("merge")
      const head = await admin((api) => api.GetRevision({ refId: fork.id, revisionId: revisions[0]!.id }))
      const prompt = (doc: unknown, id: string) =>
        (doc as { prompts: Array<{ identifier: string; content: string }> }).prompts.find((p) => p.identifier === id)!
      expect(prompt(head, "main").content).toBe("Write {{char}}'s next reply in the harbour.")
      expect(prompt(head, "jailbreak").content).toBe("Stay in character; never speak for {{user}}.")

      // History: the merge, at the head, can be undone; the parent's changes are offered again.
      await page.getByRole("button", { name: "History", exact: true }).first().click()
      const history = page.getByRole("dialog", { name: "History", exact: true })
      const undo = history.getByRole("button", { name: "Undo merge", exact: true })
      await expect(undo).toHaveCount(1)
      await expect(undo).toBeEnabled()
      await capture(page, info, history.getByRole("listitem").first(), `${width}-${theme}-history`)
      await undo.click()
      await expect(undo).toBeDisabled()
      await expect(undo).toHaveAccessibleDescription("This merge was already undone.")
      await page.keyboard.press("Escape")
      await expect(notice(page)).toContainText("The parent has 2 new revisions")
    })

test("unsaved fields refuse the merge until saved or reverted, and an older parent revision can be picked", async ({
  page
}) => {
  test.setTimeout(120_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const { fork } = await seedPresetFork(server(), " drafts")
  await admin((api) => draftField(api, fork.id, ["prompts", "identifier=main", "content"], "UNSAVED NIGHT TEXT"))
  await page.goto(`${server().url}/library/${fork.id}`)
  await notice(page).getByRole("button", { name: "Review and merge" }).click()
  const dialog = page.getByRole("dialog", { name: `Merge into ${fork.label}` })
  const unsaved = dialog.getByRole("status").filter({ hasText: "unsaved changes" })
  await expect(unsaved).toContainText("A field has unsaved changes")
  await expect(dialog.getByRole("list", { name: "Changes to merge" })).toHaveCount(0)
  await unsaved.getByRole("button", { name: "Revert", exact: true }).click()
  const changes = dialog.getByRole("list", { name: "Changes to merge" })
  await expect(changes.locator(":scope > li")).toHaveCount(2)

  // The older parent revision only rewrote Main.
  await dialog.getByRole("combobox", { name: "Parent revision" }).click()
  await page.getByRole("option").nth(1).click()
  await expect(changes.locator(":scope > li")).toHaveCount(1)
  await expect(changes).toContainText("conflict")
  // Leaving the conflicting change out needs no choice, and is said to stick.
  await changes.getByRole("switch", { name: "Take" }).click()
  await expect(dialog).toContainText("Changes left out aren't offered again for this revision.")
  await dialog.getByRole("button", { name: "Merge", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  // The newer revision is still to merge.
  await expect(notice(page)).toContainText("The parent has 1 new revision")
})

test("a stale comparison keeps the choices and compares again", async ({ page }) => {
  test.setTimeout(120_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const { fork } = await seedPresetFork(server(), " stale")
  await page.goto(`${server().url}/library/${fork.id}`)
  await notice(page).getByRole("button", { name: "Review and merge" }).click()
  const dialog = page.getByRole("dialog", { name: `Merge into ${fork.label}` })
  const rows = dialog.getByRole("list", { name: "Changes to merge" }).locator(":scope > li")
  await rows.nth(0).getByRole("radio", { name: "Edit it" }).check()
  const edited = rows.nth(0).getByRole("textbox")
  await edited.fill("Write {{char}}'s next reply, harbour at night.")
  // Another tab saves the fork meanwhile.
  await admin((api) => saveField(api, fork.id, ["prompts", "identifier=nsfw", "content"], "Another tab's text."))
  await dialog.getByRole("button", { name: "Merge", exact: true }).click()
  const failed = dialog.getByRole("alert").filter({ hasText: "Couldn't merge" })
  await expect(failed).toBeVisible()
  await failed.getByRole("button", { name: "Compare again" }).click()
  await expect(failed).toHaveCount(0)
  await expect(rows.nth(0).getByRole("textbox")).toHaveValue("Write {{char}}'s next reply, harbour at night.")
  // Carried choices must become a draft of this comparison even without another edit.
  await page.reload()
  await notice(page).getByRole("button", { name: "Review and merge" }).click()
  await expect(rows.nth(0).getByRole("textbox")).toHaveValue("Write {{char}}'s next reply, harbour at night.")
  await dialog.getByRole("button", { name: "Merge", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const [head] = await admin((api) => api.ListRevisions({ refId: fork.id, limit: 1 }))
  const doc = (await admin((api) => api.GetRevision({ refId: fork.id, revisionId: head!.id }))) as unknown as {
    prompts: Array<{ identifier: string; content: string }>
  }
  expect(doc.prompts.find((p) => p.identifier === "main")!.content).toBe(
    "Write {{char}}'s next reply, harbour at night."
  )
  expect(doc.prompts.find((p) => p.identifier === "nsfw")!.content).toBe("Another tab's text.")
})

for (const width of [1440, 390])
  test(`a lorebook fork merges from the chat's side panel and shows its family ${width}`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const lore = await importFile(
      page.request,
      server(),
      `Tides ${width}.json`,
      book(`Tides ${width}`, [
        { uid: 0, comment: "Harbour", content: "The water is calm." },
        { uid: 1, comment: "Lighthouse", content: "The lamp turns all night." }
      ])
    )
    const seed = await admin((api) =>
      Effect.gen(function* () {
        const variant = yield* api.ForkVariant({
          refId: lore.id,
          label: `Tides night ${width}`,
          subtitle: "",
          moveDrafts: false
        })
        const nested = yield* api.ForkVariant({
          refId: variant.id,
          label: `Tides storm ${width}`,
          subtitle: "",
          moveDrafts: false
        })
        yield* saveField(api, lore.id, ["entries", "uid=0", "content"], "The water is rough.")
        yield* saveField(api, lore.id, ["entries", "uid=1", "content"], "The lamp is out.")
        const card = yield* api.CreateCard({ label: `Keeper ${width}`, name: `Keeper ${width}` })
        const persona = yield* api.CreateCard({ label: `Sailor ${width}`, name: `Sailor ${width}` })
        const started = yield* api.StartChat({
          cards: [card.entityId],
          persona: persona.entityId,
          greeting: null,
          first: { _tag: "Send", content: "A synthetic harbour.", speakerEntityId: null }
        })
        yield* api.ChangeCast({
          chatId: started.chat.id,
          slotId: null,
          change: { _tag: "Lorebook", ref: variant.id, active: true }
        })
        return { variant, nested, chat: started.chat }
      })
    )
    await page.goto(`${server().url}/chats/${seed.chat.id}`)
    const panel = await openPanel(page, "Lorebooks")
    await panel.getByRole("button").filter({ hasText: seed.variant.label }).first().click()
    const editor = panel.getByRole("region", { name: `Lorebook ${seed.variant.label}`, exact: true })
    const banner = notice(editor)
    await expect(banner).toContainText("The parent has 2 new revisions")
    await capture(page, info, editor, `${width}-lorebook-panel`)

    // The family: the original, this one, its own fork; each a link that opens in the panel.
    await editor.getByRole("button", { name: "Family", exact: true }).click()
    const family = page.getByRole("dialog", { name: "Family", exact: true })
    const tree = family.getByRole("list", { name: "Family tree" })
    await expect(tree.getByRole("link", { name: lore.label, exact: true })).toHaveAttribute(
      "href",
      `/library/${lore.id}`
    )
    await expect(tree.getByRole("link", { name: seed.nested.label, exact: true })).toBeVisible()
    await expect(tree).toContainText("this one")
    await capture(page, info, family, `${width}-family`)
    await family.getByRole("button", { name: `Hide forks of ${seed.variant.label}` }).click()
    await expect(tree.getByRole("link", { name: seed.nested.label, exact: true })).toHaveCount(0)
    await page.keyboard.press("Escape")

    await banner.getByRole("button", { name: "Review and merge" }).click()
    const dialog = page.getByRole("dialog", { name: `Merge into ${seed.variant.label}` })
    const rows = dialog.getByRole("list", { name: "Changes to merge" }).locator(":scope > li")
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: "Harbour" })).toContainText("changed")
    // Take only the harbour's change.
    await rows.filter({ hasText: "Lighthouse" }).getByRole("switch", { name: "Take" }).click()
    await capture(page, info, dialog, `${width}-lorebook-review`)
    await dialog.getByRole("button", { name: "Merge", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(notice(editor)).toHaveCount(0)
    const [head] = await admin((api) => api.ListRevisions({ refId: seed.variant.id, limit: 1 }))
    const doc = (await admin((api) =>
      api.GetRevision({ refId: seed.variant.id, revisionId: head!.id })
    )) as unknown as {
      entries: Array<{ uid: number; content: string }>
    }
    expect(doc.entries.map((e) => e.content)).toEqual(["The water is rough.", "The lamp turns all night."])
  })

const cardFile = (description: string, scenario: string, entry: string) => ({
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "Wren",
    description,
    scenario,
    first_mes: "The lamp needs oil.",
    character_book: {
      name: "Wren's book",
      entries: [{ id: 0, keys: ["lamp"], content: entry, enabled: true, insertion_order: 0, extensions: {} }]
    },
    extensions: { depth_prompt: { prompt: "Wren smells of oil.", depth: 4, role: "system" } }
  }
})

test("a card merges a new version of its file instead of replacing it", async ({ page }, info) => {
  test.setTimeout(120_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const card = await importFile(
    page.request,
    server(),
    "wren.json",
    cardFile("A lighthouse keeper.", "A stormy coast.", "The lamp burns oil.")
  )
  await admin((api) => saveField(api, card.id, ["description"], "Keeps the northern light alone."))
  await page.goto(`${server().url}/library/${card.id}`)
  await page.getByRole("button", { name: "Import a new version…", exact: true }).click()
  const pick = page.getByRole("dialog", { name: "Import a new version of Wren" })
  await pick.getByLabel(/^Choose the new version's file/).setInputFiles({
    name: "wren-2.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify(cardFile("A retired lighthouse keeper.", "A calm coast.", "The lamp burns gas."))
    )
  })
  await pick.getByRole("button", { name: "Merge…", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Merge into Wren" })
  await expect(dialog).toContainText("The card's own notes keep their text.")
  const rows = dialog.getByRole("list", { name: "Changes to merge" }).locator(":scope > li")
  await expect(rows.filter({ hasText: "Scenario" })).not.toContainText("conflict")
  await expect(rows.filter({ hasText: "Description" })).toContainText("conflict")
  await expect(rows.filter({ hasText: "Lorebook" })).toHaveCount(1)
  await rows.filter({ hasText: "Description" }).getByRole("radio", { name: "Keep current version" }).check()
  await capture(page, info, dialog, "1440-card-file-merge")
  await dialog.getByRole("button", { name: "Merge", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const [head] = await admin((api) => api.ListRevisions({ refId: card.id, limit: 1 }))
  const doc = (await admin((api) => api.GetRevision({ refId: card.id, revisionId: head!.id }))) as Record<
    string,
    unknown
  >
  expect(doc.description).toBe("Keeps the northern light alone.")
  expect(doc.scenario).toBe("A calm coast.")
  expect(JSON.stringify(doc.character_book)).toContain("The lamp burns gas.")
})

test("a card fork in a chat offers its parent's changes; one marked by hand explains why it can't", async ({
  page
}) => {
  test.setTimeout(120_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const seed = await admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Gull", name: "Gull" })
      const fork = yield* api.ForkCard({ refId: card.id, name: "Gull", nickname: "", characterVersion: "night" })
      yield* saveField(api, card.id, ["description"], "A gull with one eye.")
      const stray = yield* api.CreateCard({ label: "Gull stray", name: "Gull stray" })
      yield* api.SetCardParent({ entityId: stray.entityId, parentEntityId: card.entityId })
      const persona = yield* api.CreateCard({ label: "Sailor", name: "Sailor" })
      const started = yield* api.StartChat({
        cards: [fork.entityId],
        persona: persona.entityId,
        greeting: null,
        first: { _tag: "Send", content: "A synthetic harbour.", speakerEntityId: null }
      })
      return { fork, stray, chat: started.chat }
    })
  )
  await page.goto(`${server().url}/chats/${seed.chat.id}`)
  const tab = await openPanel(page, "Gull")
  await expect(notice(tab)).toContainText("The parent has 1 new revision")
  await notice(tab).getByRole("button", { name: "Review and merge" }).click()
  const dialog = page.getByRole("dialog", { name: "Merge into Gull" })
  await expect(dialog.getByRole("list", { name: "Changes to merge" })).toContainText("Description")
  await page.keyboard.press("Escape")

  await page.goto(`${server().url}/library/${seed.stray.id}`)
  await expect(notice(page)).toContainText("marked as a fork by hand")
  await expect(notice(page).getByRole("button")).toHaveCount(0)
})

test("a refused choices draft keeps the review open without announcing a merge", async ({ page }, info) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const { fork } = await seedPresetFork(server(), " draft refusal")
  let refuse = true
  let commits = 0
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: string }) : null
      if (request?.tag === "CommitForkMerge") commits++
      if (refuse && request?.tag === "SaveUserDraft") {
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
  await page.goto(`${server().url}/library/${fork.id}`)
  await notice(page).getByRole("button", { name: "Review and merge" }).click()
  const dialog = page.getByRole("dialog", { name: `Merge into ${fork.label}` })
  await dialog.getByRole("radio", { name: "Take parent's version" }).check()
  await expect(dialog.getByRole("alert")).toBeVisible()
  await dialog.getByRole("button", { name: "Merge", exact: true }).click()
  await expect(dialog.getByRole("button", { name: "Merge", exact: true })).toBeEnabled()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("alert")).toBeVisible()
  await expect(page.getByText(`Merged into ${fork.label}`, { exact: true })).toHaveCount(0)
  expect(commits).toBe(0)
  await capture(page, info, dialog, "merge-draft-refused")
  refuse = false
  await dialog.getByRole("button", { name: "Merge", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(commits).toBe(1)
})

test("merge waits for saved exclusions to load after reopening", async ({ page }, info) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const lore = await importFile(
    page.request,
    server(),
    "draft-load.json",
    book("Draft load", [
      { uid: 0, comment: "Harbour", content: "Calm water." },
      { uid: 1, comment: "Lighthouse", content: "An oil lamp." }
    ])
  )
  const fork = await admin((api) =>
    Effect.gen(function* () {
      const fork = yield* api.ForkVariant({ refId: lore.id, label: "Draft load fork", subtitle: "", moveDrafts: false })
      yield* saveField(api, lore.id, ["entries", "uid=0", "content"], "Rough water.")
      yield* saveField(api, lore.id, ["entries", "uid=1", "content"], "A gas lamp.")
      return fork
    })
  )
  await page.goto(`${server().url}/library/${fork.id}`)
  await notice(page).getByRole("button", { name: "Review and merge" }).click()
  const dialog = page.getByRole("dialog", { name: `Merge into ${fork.label}` })
  const rows = dialog.getByRole("list", { name: "Changes to merge" }).locator(":scope > li")
  await rows.filter({ hasText: "Lighthouse" }).getByRole("switch", { name: "Take" }).click()
  const status = await admin((api) => api.ForkMergeStatus({ refId: fork.id }))
  const targetId = `merge:${fork.id}:${status.baseRevisionId}:${status.ref.headRevisionId}:${status.versions[0]!.id}`
  const ownerId = await admin((api) => Effect.map(api.Whoami(), (user) => user.id))
  await expect
    .poll(() =>
      admin((api) => Effect.map(api.GetUserDraft({ ownerId, targetId, field: "Merge choices" }), (d) => d?.content))
    )
    .toContain("uid=1")
  let release: (() => void) | undefined
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      const request =
        typeof data === "string" ? (JSON.parse(data) as { tag?: string; payload?: { targetId?: string } }) : null
      if (request?.tag === "GetUserDraft" && request.payload?.targetId === targetId) release = () => upstream.send(data)
      else upstream.send(data)
    })
    upstream.onMessage((data) => socket.send(data))
  })
  await page.reload()
  await notice(page).getByRole("button", { name: "Review and merge" }).click()
  await expect.poll(() => !!release).toBe(true)
  await expect(dialog.getByRole("button", { name: "Merge", exact: true })).not.toBeEnabled()
  await capture(page, info, dialog, "merge-choices-loading")
  release!()
  await expect(rows.filter({ hasText: "Lighthouse" }).getByRole("switch", { name: "Take" })).not.toBeChecked()
  await dialog.getByRole("button", { name: "Merge", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const [head] = await admin((api) => api.ListRevisions({ refId: fork.id, limit: 1 }))
  const doc = await admin((api) => api.GetRevision({ refId: fork.id, revisionId: head!.id }))
  expect((doc.entries as Array<{ content: string }>).map((e) => e.content)).toEqual(["Rough water.", "An oil lamp."])
})

test("held preset changes refuse review with Save and Revert", async ({ page }, info) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const { fork } = await seedPresetFork(server(), " held")
  await admin((api) => draftField(api, fork.id, ["~held"], JSON.stringify({ deleted: ["nsfw"] })))
  await page.goto(`${server().url}/library/${fork.id}`)
  await notice(page).getByRole("button", { name: "Review and merge" }).click()
  const dialog = page.getByRole("dialog", { name: `Merge into ${fork.label}` })
  const unsaved = dialog.getByRole("status").filter({ hasText: "unsaved changes" })
  await expect(unsaved.getByRole("button", { name: "Revert", exact: true })).toBeVisible()
  await capture(page, info, dialog, "merge-held-unsaved")
  await unsaved.getByRole("button", { name: "Revert", exact: true }).click()
  await expect(dialog.getByRole("list", { name: "Changes to merge" }).locator(":scope > li")).toHaveCount(2)
})

test("held preset changes disable Undo merge at the head", async ({ page }, info) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const { fork } = await seedPresetFork(server(), " held undo")
  await admin((api) =>
    Effect.gen(function* () {
      const preview = yield* api.PreviewForkMerge({ refId: fork.id })
      yield* api.CommitForkMerge({
        refId: fork.id,
        theirsRevisionId: preview.theirsRevisionId,
        baseRevisionId: preview.baseRevisionId,
        expectedRowVersion: preview.ref.rowVersion,
        selection: { excluded: [], resolutions: preview.conflicts.map((c) => ({ path: c.path, value: c.theirs })) },
        message: null
      })
      yield* draftField(api, fork.id, ["~held"], JSON.stringify({ deleted: ["nsfw"] }))
    })
  )
  await page.goto(`${server().url}/library/${fork.id}`)
  await page.getByRole("button", { name: "History", exact: true }).first().click()
  const undo = page
    .getByRole("dialog", { name: "History", exact: true })
    .getByRole("button", { name: "Undo merge", exact: true })
  await expect(undo).toBeDisabled()
  await expect(undo).toHaveAccessibleDescription("Save or revert the unsaved changes first.")
  await capture(page, info, page.getByRole("dialog", { name: "History", exact: true }), "merge-held-undo")
})

// Small fixes (spec/PHASE1-DECISIONS.md §7), at the widths where layout is the point: the
// composer's actions on the control row under its full-width text. Every card and preset here is
// made up.
import { mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "40" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-small-fixes-screenshots"))
mkdirSync(shots, { recursive: true })

const sizes = [
  [1440, 900],
  [390, 844]
] as const

/** ST's default preset, with the impersonation prompt emptied. */
const plainPreset = readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")

/** A chat with Mira, played as Bo, with the account's prompt preset one that has no impersonation prompt. */
const setUp = async (page: Page, label: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const body = Buffer.from(JSON.stringify({ ...JSON.parse(plainPreset), impersonation_prompt: "" }))
  const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(label)}.json`, {
    data: body,
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
  return admin((api) =>
    Effect.gen(function* () {
      const preset = (yield* api.ListLibrary({ kind: "preset" })).find((ref) => ref.label === label)!
      yield* api.ChangeGenerationDefaults({ change: { preset: preset.id } })
      const ids: Record<string, string> = {}
      for (const name of ["Mira", "Bo"]) {
        const existing = (yield* api.ListCards()).find((card) => card.name === name)
        const entityId = existing?.entityId ?? (yield* api.CreateCard({ label: name, name })).entityId
        ids[name] = entityId
        if (name === "Bo") yield* api.SetPersona({ entityId, persona: true })
      }
      const chat = yield* api.CreateChat({ title: label })
      for (const name of ["Mira", "Bo"])
        yield* api.ChangeCast({
          chatId: chat.id,
          slotId: null,
          change: { _tag: "Join", entityId: ids[name] as never }
        })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "PlayedByMe", entityIds: [ids.Bo as never] }
      })
      return chat.id
    })
  )
}

for (const [width, height] of sizes)
  for (const theme of ["light", "dark"] as const) {
    test(`the composer's actions sit under its full-width text, in the window (${width}px ${theme})`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      const chatId = await setUp(page, `Plain ${width} ${theme}`)
      await page.goto(`${server().url}/chats/${chatId}`)
      const box = page.getByLabel("Message", { exact: true })
      await expect(box).toBeEditable()
      const write = page.getByRole("button", { name: "Generate Bo", exact: true })
      await expect(write).toBeVisible()
      const send = page.getByRole("button", { name: /^(Send|Mira replies)$/ })
      const area = await box.boundingBox()
      const generate = await write.boundingBox()
      const sendAt = await send.boundingBox()
      // The text has a row of its own at every width (composer2, owner 2026-11-01): the actions
      // are on the box's control row under it, at its right end, in the window.
      const outline = (await page.getByTestId("composer-box").boundingBox())!
      for (const action of [generate!, sendAt!]) {
        expect(action.y).toBeGreaterThanOrEqual(area!.y + area!.height - 1)
        expect(action.x + action.width).toBeLessThanOrEqual(Math.min(width, outline.x + outline.width))
      }
      expect(area!.width).toBeGreaterThan(outline.width * 0.95)
      await page.screenshot({ path: join(shots, `composer-${width}-${theme}.png`) })
    })
  }

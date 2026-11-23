// An imported ST chat hidden up to its summary (owner, 2026-11-23): scrolled up, the line right
// above the first message sent says the messages above are hidden and names the summary sent in
// their place, with no context-size figures or action; a chat whose budget also cuts messages
// after its hidden run shows the size line under the last message cut, and the hidden line above
// the first one cut. At 1440 and 390, with the layout audit. Every file here is made up.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { crc32, deflateSync } from "node:zlib"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

const pngChunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(12 + data.byteLength)
  out.writeUInt32BE(data.byteLength, 0)
  out.write(type, 4, "latin1")
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.byteLength)), 8 + data.byteLength)
  return out
}
const card = (name: string) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 128]))),
    pngChunk(
      "tEXt",
      Buffer.from(
        `chara\0${Buffer.from(
          JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name, first_mes: "Hello." } })
        ).toString("base64")}`,
        "latin1"
      )
    ),
    pngChunk("IEND", Buffer.alloc(0))
  ])

const at = (i: number) => new Date(Date.UTC(2025, 0, 1, 10, 0, 0, i)).toISOString()
const PAD = " The river ran loud below the bridge, and the lantern swung.".repeat(16)
/** `count` messages, the first `hidden` hidden, the summary on the last of them. */
const chat = (name: string, count: number, hidden: number, pad = "") =>
  [
    { chat_metadata: {}, user_name: "unused", character_name: "unused" },
    ...Array.from({ length: count }, (_, i) => ({
      name: i % 2 ? "Sam" : name,
      is_user: i % 2 === 1,
      is_system: i < hidden,
      send_date: at(i),
      mes: `${i % 2 ? "Sam" : name} line ${i}.${i >= hidden ? pad : ""}`,
      extra: i === hidden - 1 ? { memory: `${name}'s story so far.` } : {}
    }))
  ]
    .map((line) => JSON.stringify(line))
    .join("\n")

let root = ""
let fay: ChatId
let gil: ChatId
test.beforeAll(async () => {
  test.setTimeout(120_000)
  root = mkdtempSync(join(tmpdir(), "rp-st-sumhidden-"))
  const files: Record<string, string | Buffer> = {
    "settings.json": JSON.stringify({
      extension_settings: {
        memory: { position: 0, depth: 2, role: 0, template: "[Summary: {{summary}}]" },
        disabledExtensions: []
      }
    }),
    "characters/Fay.png": card("Fay"),
    "characters/Gil.png": card("Gil"),
    // The owner's shape: 900 messages, the first 831 hidden; nothing after them is cut.
    "chats/Fay/Fay - long.jsonl": chat("Fay", 900, 831),
    // Hidden up to 249, then 50 long messages: the 12k window cuts some of them too.
    "chats/Gil/Gil - both.jsonl": chat("Gil", 300, 250, PAD)
  }
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, "ST/data/default-user", path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  const ids = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Window",
          baseUrl: "http://127.0.0.1:9/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "window",
        overrides: { context: 12_000 }
      })
      yield* api.ChangeGenerationDefaults({ change: { model: { connection: connection.id, model: model.id } } })
      const { importId } = yield* api.StartStPathImport({ path: join(root, "ST/data/default-user"), prefix: "" })
      for (let i = 0; i < 1200; i++) {
        const detail = yield* api.GetStImport({ importId })
        if (detail.job.status !== "running") {
          const runs = detail.report!.hiddenRuns
          return {
            fay: runs.find((run) => run.hidden === 831)!.chatId,
            gil: runs.find((run) => run.hidden === 250)!.chatId
          }
        }
        yield* Effect.sleep(50)
      }
      throw new Error("the import didn't finish")
    })
  )
  fay = ids.fay
  gil = ids.gil
})
test.afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const message = (page: Page, text: string) => page.locator("article[data-slot]").filter({ hasText: text })
/** Scrolls up from the newest messages until `target` renders (the list is virtualized). */
const scrollTo = async (page: Page, width: number, target: Locator) => {
  await page.mouse.move(width / 2, 400)
  for (let i = 0; i < 200 && (await target.count()) === 0; i++) await page.mouse.wheel(0, -400)
  await target.scrollIntoViewIfNeeded()
  await expect(target).toBeVisible()
}
const above = async (upper: Locator, lower: Locator) => {
  const a = (await upper.boundingBox())!
  const b = (await lower.boundingBox())!
  expect(a.y + a.height).toBeLessThanOrEqual(b.y + 1)
}

for (const width of [1440, 390]) {
  test(`a chat hidden up to its summary says so above the first message sent at ${width}`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${fay}`)
    await expect(message(page, "Fay line 898.")).toBeVisible()
    const line = page.getByRole("status").filter({ hasText: "Messages above this are hidden." })
    await scrollTo(page, width, line)
    await expect(line).toHaveText("Messages above this are hidden. Summary (from ST) is sent in their place.")
    await expect(line.getByRole("button")).toHaveCount(0)
    // No size claim anywhere: nothing was cut for size.
    await expect(page.getByText("aren’t sent to the model")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Change the context size" })).toHaveCount(0)
    // Right below the last hidden message, right above the first one sent.
    const last = message(page, "Fay line 830.")
    const first = message(page, "Sam line 831.")
    await expect(last).toHaveAttribute("data-hidden", "true")
    await expect(first).not.toHaveAttribute("data-hidden")
    await expect(first).not.toHaveAttribute("data-out-of-context")
    // A hidden message shows its Hidden mark, never the out-of-context style.
    await expect(last).not.toHaveAttribute("data-out-of-context")
    await above(last, line)
    await above(line, first)
    await expectLayout(page, info, `hidden line ${width}`)
  })

  test(`a size cut below a hidden run puts each line at its place at ${width}`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${gil}`)
    await expect(message(page, "Sam line 299.")).toBeVisible()
    // Messages were cut for size: summaries would keep them.
    await expect(page.getByRole("button", { name: "Enable summaries" })).toBeVisible()
    const size = page.getByRole("status").filter({ hasText: "aren’t sent to the model" })
    await scrollTo(page, width, size)
    await expect(size).toContainText("12,000 tokens")
    await expect(size.getByRole("button", { name: "Change the context size" })).toBeVisible()
    // Under the last message cut, above the first one sent.
    const rows = page.locator("article[data-slot]")
    const sizeBox = (await size.boundingBox())!
    const boxes = await rows.evaluateAll((all) =>
      all.map((row) => {
        const box = row.getBoundingClientRect()
        return { y: box.y, bottom: box.bottom, out: row.hasAttribute("data-out-of-context") }
      })
    )
    const before = boxes.filter((b) => b.bottom <= sizeBox.y + 1).at(-1)!
    const after = boxes.find((b) => b.y >= sizeBox.y + sizeBox.height - 1)!
    expect(before.out).toBe(true)
    expect(after.out).toBe(false)
    await expectLayout(page, info, `size line ${width}`)

    // Further up, the hidden line above the first message cut.
    const hidden = page.getByRole("status").filter({ hasText: "Messages above this are hidden." })
    await scrollTo(page, width, hidden)
    await expect(hidden).toHaveText("Messages above this are hidden. Summary (from ST) is sent in their place.")
    await expect(hidden.getByRole("button")).toHaveCount(0)
    const last = message(page, "Sam line 249.")
    const firstCut = message(page, "Gil line 250.")
    await expect(last).toHaveAttribute("data-hidden", "true")
    await expect(firstCut).toHaveAttribute("data-out-of-context", "true")
    await above(last, hidden)
    await above(hidden, firstCut)
    await expectLayout(page, info, `hidden line above a cut ${width}`)
  })
}

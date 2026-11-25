// While a reply is written, its disclosures (the Reasoning panel, the steps element) must not
// flash open and closed (owner, 2026-11-25). Short thinking completes in an instant, so one
// opens on its own only after streaming for AUTO_OPEN.afterMs (a reply whose thinking completes
// sooner never opens it), and stays open at least AUTO_OPEN.minOpenMs before folding (DESIGN §7.4).
// A frame-by-frame sampler records every disclosure's open state against a synthetic provider
// with a fast mode (thinking done in about 50 ms, then the reply goes on for a second) and a slow
// one (about 2 s of thinking), for a plain reply and a tool-written one (thought, a tool call,
// text). Fast: never open. Slow: each element opens once and folds once, in that order.
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import type { SlotId } from "@dreamspan/shared/chat.ts"
import { AUTO_OPEN } from "../src/features/chat/autoOpen.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

let mode: "fast" | "slow" = "fast"
const AGENT_END = "tooldone"
const WORDS = Array.from({ length: 14 }, (_, i) => `word${i} `)
/** Thinking: fast, done in about 50 ms; slow, 2 s. Text: a second either way. */
const thoughts = () => Array.from({ length: mode === "fast" ? 5 : 20 }, (_, i) => `thought${i} `)
const gap = () => (mode === "fast" ? 10 : 100)
const TEXT_GAP = 70

const chunk = (delta: object, finish: string | null = null, usage?: object) =>
  `data: ${JSON.stringify({
    id: "slow",
    object: "chat.completion.chunk",
    model: "slow-small",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {})
  })}\n\n`

type Part = readonly [string, number]

const startSlowProvider = async () => {
  const usage = { prompt_tokens: 100, completion_tokens: 10 }
  const stream = (res: ServerResponse, parts: ReadonlyArray<Part>) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    let i = 0
    const next = () => {
      if (res.destroyed) return
      const part = parts[i++]
      if (!part) return void res.end("data: [DONE]\n\n")
      res.write(part[0])
      setTimeout(next, part[1])
    }
    next()
  }
  const thinking = (): Array<Part> =>
    thoughts().map((t, i) => [
      chunk(i === 0 ? { role: "assistant", reasoning_content: t } : { reasoning_content: t }),
      gap()
    ])
  const http = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ object: "list", data: [{ id: "slow-small", object: "model" }] }))
    }
    if (req.url !== "/v1/chat/completions") return res.writeHead(404).end()
    let raw = ""
    req.on("data", (c: Buffer) => (raw += c.toString()))
    req.on("end", () => {
      const body = JSON.parse(raw) as {
        tools?: Array<{ function?: { name?: string } }>
        messages: Array<{ role: string }>
      }
      const text = (): Array<Part> => [
        ...WORDS.map((t): Part => [chunk({ content: t }), TEXT_GAP]),
        [chunk({ content: AGENT_END }), 0],
        [chunk({}, "stop"), 0],
        [chunk({}, null, usage), 0]
      ]
      if (!body.tools) return stream(res, [...thinking(), ...text()])
      const done = body.messages.filter((m) => m.role === "tool").length
      const call = (name: string, args: string): Array<Part> => [
        [
          chunk({ tool_calls: [{ index: 0, id: `call_${done}`, type: "function", function: { name, arguments: "" } }] }),
          0
        ],
        ...args
          .match(/.{1,6}/gs)!
          .map((a): Part => [chunk({ tool_calls: [{ index: 0, function: { arguments: a } }] }), 0]),
        [chunk({}, "tool_calls"), 0],
        [chunk({}, null, usage), 0]
      ]
      if (done < 1) return stream(res, [...thinking(), ...call("search_chat", JSON.stringify({ query: "bridge" }))])
      if (body.tools.some((t) => t.function?.name === "send_message"))
        return stream(res, [
          ...thinking(),
          ...WORDS.map((): Part => [chunk({}), mode === "fast" ? 2 : TEXT_GAP]),
          ...call("send_message", JSON.stringify({ message: `${WORDS.join("")}${AGENT_END}` }))
        ])
      return stream(res, [...thinking(), ...text()])
    })
  })
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done))
  return {
    baseUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`,
    stop: () =>
      new Promise<void>((done) => {
        http.closeAllConnections()
        http.close(() => done())
      })
  }
}

interface Sample {
  readonly t: number
  readonly key: string
  readonly open: boolean | null
  readonly el: number
}

/** Samples every disclosure in the last message on each animation frame; logs changes only. */
const install = (page: Page) =>
  page.addInitScript(() => {
    const ids = new WeakMap<Element, number>()
    let next = 1
    const log: Array<Sample> = []
    const last = new Map<string, string>()
    ;(window as unknown as { __disclosures: typeof log }).__disclosures = log
    const frame = () => {
      const article = [...document.querySelectorAll("article")].at(-1)
      const seen = new Set<string>()
      if (article) {
        const found: Array<[string, Element]> = []
        for (const b of article.querySelectorAll("[data-reasoning-panel] > div > button[aria-expanded]"))
          found.push([`reasoning:${b.closest("[data-reasoning-panel]")!.getAttribute("data-reasoning-panel")}`, b])
        for (const b of article.querySelectorAll("[data-steps-panel] > div > button[aria-expanded]"))
          found.push(["steps", b])
        for (const [key, el] of found) {
          if (!ids.has(el)) ids.set(el, next++)
          seen.add(key)
          const state = `${el.getAttribute("aria-expanded")}|${ids.get(el)}`
          if (last.get(key) !== state) {
            last.set(key, state)
            log.push({
              t: performance.now(),
              key,
              open: el.getAttribute("aria-expanded") === "true",
              el: ids.get(el)!
            })
          }
        }
      }
      for (const key of [...last.keys()])
        if (!seen.has(key) && last.get(key) !== "gone") {
          last.set(key, "gone")
          log.push({ t: performance.now(), key, open: null, el: 0 })
        }
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })

const read = (page: Page) =>
  page.evaluate(() => (window as unknown as { __disclosures: Array<Sample> }).__disclosures.splice(0))

const byElement = (log: ReadonlyArray<Sample>, pattern: RegExp) => {
  const by = new Map<number, Array<Sample>>()
  for (const s of log) if (s.el !== 0 && pattern.test(s.key)) by.set(s.el, [...(by.get(s.el) ?? []), s])
  return [...by.values()]
}

/** Fast: the element never opened (it may be replaced as a tool-written reply's turns change). */
const expectNeverOpen = (log: ReadonlyArray<Sample>, pattern: RegExp) => {
  const elements = byElement(log, pattern)
  expect(elements.length, `${pattern} was seen`).toBeGreaterThan(0)
  for (const list of elements)
    expect(
      list.map((s) => s.open),
      `${pattern} opened: ${JSON.stringify(list)}`
    ).not.toContain(true)
}

/**
 * Slow: an element opened once and folded once, in that order, and none changed the other way;
 * it opened only after AUTO_OPEN.afterMs of streaming and stayed open for AUTO_OPEN.minOpenMs.
 */
const expectOpenedOnceThenFolded = (log: ReadonlyArray<Sample>, pattern: RegExp) => {
  let full = 0
  for (const list of byElement(log, pattern)) {
    const story = JSON.stringify(list)
    const states = list.map((s) => s.open)
    const trimmed = states[0] === false ? states.slice(1) : states
    expect(
      trimmed.length <= 2 && (trimmed.length < 2 || (trimmed[0] === true && trimmed[1] === false)),
      `${pattern} flickered: ${story}`
    ).toBe(true)
    if (trimmed.length === 2) {
      full++
      const opened = list.find((s) => s.open === true)!
      const folded = list.find((s) => s.open === false && s.t > opened.t)!
      expect(opened.t - list[0]!.t, `${pattern} opened early: ${story}`).toBeGreaterThanOrEqual(
        AUTO_OPEN.afterMs - 100
      )
      expect(folded.t - opened.t, `${pattern} folded early: ${story}`).toBeGreaterThanOrEqual(
        AUTO_OPEN.minOpenMs - 100
      )
    }
  }
  expect(full, `${pattern} opened and folded once: ${JSON.stringify(log)}`).toBeGreaterThanOrEqual(1)
}

test("disclosures open only after streaming a while and never flash", async ({ page }) => {
  test.setTimeout(180_000)
  const provider = await startSlowProvider()
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await install(page)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        yield* api.SetDisplayPrefs({ prefs: { steps: "expanded", reasoning: "expanded" } })
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Slow synthetic",
            baseUrl: provider.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        const model = yield* api.AddUserModel({ connectionId: connection.id, key: "slow-small", overrides: {} })
        yield* api.SetGenerationDefaults({
          defaults: { model: { connection: connection.id, model: model.id }, preset: null }
        })
        const created = yield* api.CreateChat({ title: "Flicker" })
        const sent = yield* api.SendMessage({
          chatId: created.id,
          parentSlotId: null,
          branch: false,
          content: "First question?"
        })
        if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
        return created
      })
    )
    const replyButton = () => page.getByRole("button", { name: /^(Reply$|Generate(?! another))/ }).last()
    const ask = async (content: string) => {
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: path.entries.at(-1)!.slotId as SlotId,
            branch: false,
            content
          })
          if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
        })
      )
      await expect(page.getByTestId("messages").getByText(content)).toBeVisible()
    }
    /** One reply, from its click until it has arrived and folded: the samples it made. */
    const reply = async (done: string) => {
      await read(page)
      await replyButton().click()
      const article = page.getByRole("article").last()
      await expect(article).toContainText(done)
      await expect(article.locator('[data-steps-panel="done"], [data-reasoning-panel]').first()).toBeVisible()
      await page.waitForTimeout(1500)
      return read(page)
    }
    await page.goto(`${server().url}/chats/${chat.id}`)

    // A plain reply whose thinking completes in an instant, with text still to come: never opens.
    mode = "fast"
    expectNeverOpen(await reply("word13"), /^reasoning:reasoning$/)

    // Thinking that streams for 2 s: opens once, then folds once.
    mode = "slow"
    await ask("Second question?")
    expectOpenedOnceThenFolded(await reply("word13"), /^reasoning:reasoning$/)

    // Tool-written replies: the steps element and its thinking.
    const settings = await openPanel(page, "This chat")
    await settings.getByRole("switch", { name: "Tools", exact: true }).click()
    await expect(settings.getByRole("switch", { name: "Tools", exact: true })).toBeChecked()
    mode = "fast"
    await ask("Third question?")
    const quick = await reply(AGENT_END)
    expectNeverOpen(quick, /^steps$/)
    expectNeverOpen(quick, /^reasoning:/)
    mode = "slow"
    await ask("Fourth question?")
    const long = await reply(AGENT_END)
    expectOpenedOnceThenFolded(long, /^steps$/)
    expectOpenedOnceThenFolded(long, /^reasoning:/)
  } finally {
    await provider.stop()
  }
})

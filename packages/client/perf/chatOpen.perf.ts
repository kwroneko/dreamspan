// Opt-in paired comparison against an archived client build, on one server/database.
// CHAT_OPEN_DATA, CHAT_OPEN_REFERENCE and CHAT_OPEN_WORK must point outside the checkout.
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { loadavg } from "node:os"
import { join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { expect, test } from "@playwright/test"
import type { ChatId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { ADMIN, apiLogin, startServer, withAdmin } from "../e2e/support/server.ts"
import { asUser } from "../e2e/support/rpc.ts"

interface Milestones {
  start: number
  epoch: number
  editable: number | null
  painted: number | null
  attachments: number | null
  longTasks: Array<{ start: number; duration: number }>
}
interface Read {
  id: string
  tag: string
  start: number
  end?: number
}
interface Sample {
  build: string
  pair: number
  order: number
  load: number[]
  controllerMs: number
  milestones: Milestones
  reads: Read[]
}

/** Reject interference without stopping anybody else's process. */
function otherHeavyJobs() {
  const processes = execFileSync("ps", ["-eo", "pid,ppid,comm,args"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [pid, parent, command, ...args] = line.trim().split(/\s+/)
      return { pid: Number(pid), parent: Number(parent), command, args: args.join(" ") }
    })
  const ancestors = new Set<number>()
  for (let pid = process.pid; pid > 1; pid = processes.find((p) => p.pid === pid)?.parent ?? 0) ancestors.add(pid)
  return processes
    .filter(
      (p) =>
        !ancestors.has(p.pid) &&
        ["MainThread", "node"].includes(p.command ?? "") &&
        /\/playwright(?:\/cli\.js)? test|vitest\.mjs run|scripts\/check\.ts|\/vite(?:\/bin\/vite\.js)? build/.test(
          p.args
        )
    )
    .map((p) => ({ pid: p.pid, kind: /playwright/.test(p.args) ? "browser tests" : "build/check/tests" }))
}

test("interleaved reference/current chat opening", async ({ browser }) => {
  const data = process.env.CHAT_OPEN_DATA
  const reference = process.env.CHAT_OPEN_REFERENCE
  const work = process.env.CHAT_OPEN_WORK
  const chatId = process.env.CHAT_OPEN_CHAT as ChatId | undefined
  test.skip(!data || !reference || !work || !chatId, "requires an explicit synthetic dataset and reference build")
  const runs = Number(process.env.CHAT_OPEN_RUNS ?? 15)
  const current = resolve(process.env.CHAT_OPEN_CURRENT ?? "packages/client/dist")
  mkdirSync(work!, { recursive: true })
  const link = join(work!, "client")
  const select = (dist: string) => {
    const next = `${link}.next`
    symlinkSync(resolve(dist), next)
    renameSync(next, link)
  }
  select(reference!)
  const server = await startServer({ ...withAdmin, DATA_DIR: data!, CLIENT_DIST: link, DB_READERS: "2" })
  const contexts = [await browser.newContext(), await browser.newContext()]
  const samples: Sample[] = []
  const output = join(work!, "samples.json")
  const metadata = {
    reference: resolve(reference!),
    current,
    data: resolve(data!),
    chatId,
    runs,
    before: execFileSync("uptime", { encoding: "utf8" }).trim(),
    started: new Date().toISOString(),
    viewport: { width: 1280, height: 900 }
  }
  writeFileSync(join(work!, "environment.json"), JSON.stringify(metadata, null, 2))
  try {
    await asUser(server, ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const chat = yield* api.GetChat({ chatId: chatId! })
        // Do this before measuring: opening an existing draft performs no write.
        yield* api.OpenComposer({ chatId: chat.id, forkId: chat.currentForkId })
        return { user: yield* api.GetSession(), forkId: chat.currentForkId }
      })
    )
    for (const context of contexts) {
      await apiLogin(context.request, server, ADMIN.handle, ADMIN.password)
      await context.addInitScript(() => {
        const state: Milestones = {
          start: 0,
          epoch: 0,
          editable: null,
          painted: null,
          attachments: null,
          longTasks: []
        }
        Object.assign(window, { __chatOpenTiming: state })
        new PerformanceObserver((list) => {
          if (!state.start) return
          for (const e of list.getEntries())
            if (e.startTime >= state.start)
              state.longTasks.push({ start: e.startTime - state.start, duration: e.duration })
        }).observe({ type: "longtask", buffered: true })
        const check = () => {
          if (!state.start) return
          const composer = document.querySelector<HTMLTextAreaElement>("#composer")
          if (composer && !composer.readOnly && composer.offsetHeight > 0 && state.editable === null) {
            state.editable = performance.now() - state.start
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                state.painted = performance.now() - state.start
              })
            )
          }
          const attach = document.querySelector<HTMLButtonElement>('button[aria-label="Attach images"]')
          if (composer && !composer.readOnly && attach && !attach.disabled && state.attachments === null)
            state.attachments = performance.now() - state.start
        }
        document.addEventListener(
          "click",
          (event) => {
            if (!(event.target instanceof Element) || !event.target.closest("button[data-chat-id]")) return
            state.start = performance.now()
            state.epoch = Date.now()
            check()
          },
          true
        )
        new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true })
      })
    }
    const measure = async (build: number, pair: number, order: number) => {
      expect(otherHeavyJobs(), "measurement needs a quiet window").toEqual([])
      select(build === 0 ? reference! : current)
      const page = await contexts[build]!.newPage()
      await page.setViewportSize(metadata.viewport)
      const reads: Read[] = []
      const pending = new Set<string>()
      let last = Date.now()
      page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => {
          for (const line of payload.toString().split("\n").filter(Boolean)) {
            const m = JSON.parse(line) as { _tag: string; tag: string; id: string; requestId: string }
            if (m._tag === "Interrupt") pending.delete(m.requestId)
            if (m._tag !== "Request") continue
            if (!m.tag.startsWith("Subscribe")) pending.add(m.id)
            reads.push({ id: m.id, tag: m.tag, start: Date.now() })
            last = Date.now()
          }
        })
        socket.on("framereceived", ({ payload }) => {
          for (const line of payload.toString().split("\n").filter(Boolean)) {
            const m = JSON.parse(line) as { _tag: string; requestId: string }
            if (m._tag !== "Exit") continue
            pending.delete(m.requestId)
            const read = reads.find((r) => r.id === m.requestId)
            if (read) read.end = Date.now()
            last = Date.now()
          }
        })
      })
      const idle = () =>
        expect
          .poll(() => (pending.size === 0 ? Date.now() - last : 0), { timeout: 30000, intervals: [100] })
          .toBeGreaterThan(700)
      try {
        // The panel at Snippets: a sidebar row carries the URL's tab to the chat it opens.
        await page.goto(`${server.url}/?side=chats&panel=snippets`)
        const target = page.locator(`button[data-chat-id="${chatId}"]`).first()
        await expect(target).toBeVisible()
        await idle()
        const first = reads.length
        const started = performance.now()
        await target.click()
        await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
        const controllerMs = performance.now() - started
        await page.waitForFunction(() => {
          const t = (window as unknown as { __chatOpenTiming: Milestones }).__chatOpenTiming
          return t.painted !== null && t.attachments !== null
        })
        await idle()
        const milestones = await page.evaluate(
          () => (window as unknown as { __chatOpenTiming: Milestones }).__chatOpenTiming
        )
        const interference = otherHeavyJobs()
        if (interference.length > 0) {
          writeFileSync(
            join(work!, "INVALID-WINDOW.json"),
            JSON.stringify({ interference, at: new Date().toISOString() }, null, 2)
          )
          expect(interference, "another heavy job started during measurement").toEqual([])
        }
        const sample = {
          build: build === 0 ? "reference" : "current",
          pair,
          order,
          load: loadavg(),
          controllerMs,
          milestones,
          reads: reads.slice(first)
        }
        if (pair >= 0) {
          samples.push(sample)
          writeFileSync(output, JSON.stringify(samples, null, 2))
        }
        console.log(
          JSON.stringify({
            ...sample,
            reads: sample.reads.length,
            milestones: { ...milestones, longTasks: milestones.longTasks.length }
          })
        )
      } finally {
        await page.close()
      }
    }
    // Equal discarded warmups prime each context's HTTP cache and the same server's readers.
    for (let i = 0; i < 2; i++) {
      await measure(0, -1, 0)
      await measure(1, -1, 1)
    }
    for (let pair = 0; pair < runs; pair++) {
      const first = pair % 2
      await measure(first, pair, 0)
      await measure(1 - first, pair, 1)
    }
    writeFileSync(
      join(work!, "environment.json"),
      JSON.stringify(
        { ...metadata, after: execFileSync("uptime", { encoding: "utf8" }).trim(), ended: new Date().toISOString() },
        null,
        2
      )
    )
    expect(samples.filter((s) => s.build === "reference")).toHaveLength(runs)
    expect(samples.filter((s) => s.build === "current")).toHaveLength(runs)
  } finally {
    for (const context of contexts) await context.close()
    await server.stop()
    rmSync(link, { force: true })
  }
})

// Full round trips over a bounded 6,000-message fixture and browser; host load is recorded.
import { rmSync, writeFileSync } from "node:fs"
import { loadavg } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { expect, test } from "@playwright/test"
import { prepare } from "./fixtures.ts"
import { startServer, withClient } from "./support.ts"

test("reading spacing: full top-bottom-top round trips", async ({ page }, info) => {
  test.skip(process.env.PERF_LONG_MESSAGES !== "6000", "Opt-in bounded full-length review")
  test.setTimeout(30 * 60_000)
  const { fixture, dataDir } = await prepare()
  const server = await startServer(dataDir)
  const edges = await withClient(server, (api) =>
    Effect.gen(function* () {
      let path = yield* api.ReadPath({
        chatId: fixture.long.chatId,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 500
      })
      const last = path.entries.at(-1)!.slotId
      let count = path.entries.length
      while (path.older !== null) {
        path = yield* api.ReadPath({
          chatId: fixture.long.chatId,
          leafSlotId: null,
          range: { _tag: "Older", from: path.older },
          limit: 500
        })
        count += path.entries.length
      }
      return { first: path.entries[0]!.slotId, last, count }
    })
  )
  expect(edges.count).toBe(6000)
  const results: unknown[] = []
  try {
    const densities =
      process.env.PERF_DENSITY === "compact"
        ? (["compact"] as const)
        : process.env.PERF_DENSITY === "comfortable"
          ? (["comfortable"] as const)
          : (["comfortable", "compact"] as const)
    for (const density of densities) {
      await withClient(server, (api) => api.SetDisplayPrefs({ prefs: { chatDensity: density } }))
      await page.goto(`${server.url}/chats/${fixture.long.chatId}`)
      const list = page.getByTestId("messages")
      await expect(list.locator("article[data-slot]").last()).toBeVisible()
      if (process.env.READING_MASTER_ROUNDTRIP !== "1") await expect(list).toHaveAttribute("data-chat-density", density)
      await page.waitForTimeout(500)
      await page.evaluate(() => {
        const state = {
          long: [] as number[],
          frames: [] as number[],
          blank: 0,
          largestGap: 0,
          gapExamples: [] as unknown[],
          on: true
        }
        ;(window as unknown as { __densityMeasure: typeof state }).__densityMeasure = state
        new PerformanceObserver((entries) => {
          if (state.on) for (const e of entries.getEntries()) state.long.push(e.duration)
        }).observe({ type: "long-animation-frame" })
        let previous = performance.now()
        const tick = (now: number) => {
          if (!state.on) return
          state.frames.push(now - previous)
          previous = now
          const list = document.querySelector('[data-testid="messages"]')!
          const view = list.getBoundingClientRect()
          const rows = [...list.querySelectorAll(".chat-row")]
            .map((row) => row.getBoundingClientRect())
            .filter((row) => row.bottom > view.top && row.top < view.bottom)
            .sort((a, b) => a.top - b.top)
          let covered = view.top
          let gap = 0
          for (const row of rows) {
            gap = Math.max(gap, row.top - covered)
            covered = Math.max(covered, row.bottom)
          }
          gap = Math.max(gap, view.bottom - covered)
          state.largestGap = Math.max(state.largestGap, gap)
          // The list has 16 px end padding and at most 6 px between rows.
          if (gap > 24) {
            state.blank++
            if (state.gapExamples.length < 8)
              state.gapExamples.push({
                gap,
                top: (list as HTMLElement).scrollTop,
                height: list.scrollHeight,
                viewport: { top: view.top, bottom: view.bottom },
                rows: rows.map((r) => ({ top: r.top, bottom: r.bottom }))
              })
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      let steps = 0
      for (const direction of [-1, 1, -1]) {
        let steady = 0
        while (steady < 8) {
          const moved = await list.evaluate(
            async (el, { direction, rowSteps }) => {
              const before = el.scrollTop
              const top = el.getBoundingClientRect().top
              const rows = [...el.querySelectorAll<HTMLElement>(".chat-row")]
              const first = rows.findIndex((row) => row.getBoundingClientRect().bottom > top + 1)
              const target = rowSteps && first >= 0 ? rows[first + direction * rowSteps] : undefined
              // A row-paced comparison admits the same message count per step despite the
              // different pixel heights. Pixel paging remains available for gap stress.
              el.scrollTop = target
                ? before + target.getBoundingClientRect().top - top
                : before + direction * el.clientHeight * (rowSteps ? 0.5 : 1.5)
              await new Promise(requestAnimationFrame)
              await new Promise(requestAnimationFrame)
              return Math.abs(el.scrollTop - before) > 1
            },
            { direction, rowSteps: process.env.PERF_ROW_STEPS === "2" ? 2 : 0 }
          )
          steady = moved ? 0 : steady + 1
          steps++
          if (steps % 1000 === 0) console.log(`[round trip] ${density} direction ${direction}, ${steps} scroll steps`)
          if (
            steady === 8 &&
            (await list.locator(`article[data-slot="${direction < 0 ? edges.first : edges.last}"]`).count()) === 0
          )
            steady = 0
          if (steady) await page.waitForTimeout(80)
          if (steps > 20000) throw Error("round trip did not reach its edge")
        }
        const edge = await list.evaluate((el) => ({
          top: el.scrollTop,
          end: el.scrollHeight - el.scrollTop - el.clientHeight
        }))
        expect(direction < 0 ? edge.top : edge.end).toBeLessThanOrEqual(2)
        await expect(list.locator(`article[data-slot="${direction < 0 ? edges.first : edges.last}"]`)).toBeInViewport()
        console.log(`[round trip] ${density} reached ${direction < 0 ? "first" : "last"} of ${edges.count} messages`)
      }
      const result = await page.evaluate(() => {
        const state = (
          window as unknown as {
            __densityMeasure: {
              on: boolean
              frames: number[]
              long: number[]
              blank: number
              largestGap: number
              gapExamples: unknown[]
            }
          }
        ).__densityMeasure
        state.on = false
        const frames = state.frames.toSorted((a, b) => a - b)
        return {
          blankFrames: state.blank,
          largestGapPx: state.largestGap,
          gapExamples: state.gapExamples,
          frames: frames.length,
          frameP95: frames[Math.floor(frames.length * 0.95)],
          longFramesOver100: state.long.filter((n) => n > 100).length,
          worstFrame: Math.max(0, ...state.long)
        }
      })
      const record = {
        density,
        rowSteps: process.env.PERF_ROW_STEPS === "2" ? 2 : 0,
        build: process.env.READING_MASTER_ROUNDTRIP === "1" ? "master" : "review",
        steps,
        load: loadavg(),
        ...result
      }
      console.log(JSON.stringify(record))
      results.push(record)
      writeFileSync(join(info.project.outputDir, "density-roundtrips.json"), JSON.stringify(results, null, 2))
      expect.soft(result.blankFrames).toBe(0)
      expect.soft(result.frameP95!).toBeLessThanOrEqual(70)
    }
    writeFileSync(join(info.project.outputDir, "density-roundtrips.json"), JSON.stringify(results, null, 2))
  } finally {
    await server.stop()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

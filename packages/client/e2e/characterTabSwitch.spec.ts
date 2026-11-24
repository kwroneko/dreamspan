// Switching the characters' Show tabs (owner, 2026-11-23: "Transitions should not flash annoying
// intermediate states"): on the home grid and in the left panel's grid, every pair of tabs, both
// ways, recorded every animation frame from the click until it settles. The tab strip, the search
// box and the sort bar never move, the scroll container keeps its width (no scrollbar coming and
// going), the first tile is where the old tab had it or where the new one has it and nowhere in
// between, and no loading element shows. At the owner's scale: 53 personas, 50 groups, enough
// of each to scroll. Every name is made up.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(300_000)
// Real, space-taking scrollbars, as the owner's browser has: a scrollbar that comes and goes moves the page.
test.use({
  launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--disable-features=OverlayScrollbar"] }
})

test.beforeAll(async () => {
  await admin((api) =>
    Effect.gen(function* () {
      const characters = []
      for (let i = 0; i < 40; i++) {
        const card = yield* api.CreateCard({ label: `Traveller ${i + 1}`, name: `Traveller ${i + 1}` })
        characters.push(card)
        if (i % 6 === 0) yield* api.SetCardFavourite({ entityId: card.entityId, favourite: true })
      }
      for (let i = 0; i < 53; i++) {
        const card = yield* api.CreateCard({ label: `Persona ${i + 1}`, name: `Persona ${i + 1}` })
        yield* api.SetPersona({ entityId: card.entityId, persona: true })
      }
      for (let i = 0; i < 4; i++) {
        const card = yield* api.CreateCard({ label: `Shelved ${i + 1}`, name: `Shelved ${i + 1}` })
        yield* api.SetRefArchived({ refId: card.id, archived: true })
      }
      // 50 groups: chats of two or three characters, each with a line (a join alone doesn't count).
      for (let i = 0; i < 50; i++) {
        const chat = yield* api.CreateChat({ title: `Gathering ${i + 1}` })
        const cast = [
          characters[i % 20]!,
          characters[(i + 7) % 20]!,
          ...(i % 3 === 0 ? [characters[(i + 13) % 20]!] : [])
        ]
        for (const member of cast)
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: member.entityId } })
        yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Hello.", reply: false })
      }
    })
  )
})

type Box = { x: number; y: number; w: number; h: number } | null
type Frame = {
  t: number
  tabs: Box
  search: Box
  sort: Box
  tile: Box
  scrollWidth: number
  pageWidth: number
  loading: ReadonlyArray<string>
}

declare global {
  interface Window {
    __tabFrames?: { frames: Array<Frame>; added: Array<string>; stop: boolean }
  }
}

/** Starts recording every frame of `scope` (a CSS selector) until `stopRecording`. */
const startRecording = (page: Page, scope: string) =>
  page.evaluate((scope) => {
    const root = document.querySelector<HTMLElement>(scope)!
    const box = (el: Element | null | undefined): Box => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        x: Math.round(r.x * 2) / 2,
        y: Math.round(r.y * 2) / 2,
        w: Math.round(r.width * 2) / 2,
        h: Math.round(r.height * 2) / 2
      }
    }
    const tabsOf = () => root.querySelector('[role="group"][aria-label="Show"], [role="combobox"][aria-label="Show"]')
    const scroller = () => {
      for (let el = tabsOf()?.parentElement; el; el = el.parentElement) {
        const y = getComputedStyle(el).overflowY
        if (y === "auto" || y === "scroll") return el
      }
      return document.scrollingElement as HTMLElement
    }
    const LOADING = '[role="status"], [aria-busy="true"], .animate-spin'
    const visibleLoading = () =>
      [...root.querySelectorAll<HTMLElement>(LOADING)]
        .filter((el) => el.checkVisibility())
        .map((el) => `${el.getAttribute("role") ?? el.tagName.toLowerCase()}: ${el.textContent?.trim() ?? ""}`)
    const baseline = new Set(visibleLoading())
    const record: NonNullable<Window["__tabFrames"]> = { frames: [], added: [], stop: false }
    window.__tabFrames = record
    // Anything loading-like put in at all, even between frames.
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations)
        for (const node of m.addedNodes)
          if (node instanceof HTMLElement)
            for (const el of [node, ...node.querySelectorAll<HTMLElement>(LOADING)])
              if (el.matches(LOADING))
                record.added.push(`${el.getAttribute("role") ?? el.tagName}: ${el.textContent?.trim()}`)
    })
    observer.observe(root, { subtree: true, childList: true })
    const start = performance.now()
    const frame = () => {
      const scroll = scroller()
      record.frames.push({
        t: Math.round(performance.now() - start),
        tabs: box(tabsOf()),
        search: box(root.querySelector('input[type="search"]')),
        sort: box(root.querySelector(".card-grid-sort")),
        tile: box(root.querySelector('[aria-label="Characters"] a, [aria-label="Groups"] a')),
        scrollWidth: scroll.clientWidth,
        pageWidth: document.documentElement.clientWidth,
        loading: visibleLoading().filter((l) => !baseline.has(l))
      })
      if (record.stop) observer.disconnect()
      else requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }, scope)

const stopRecording = (page: Page) =>
  page.evaluate(() => {
    const record = window.__tabFrames!
    record.stop = true
    return { frames: record.frames, added: record.added }
  })

const same = (a: Box, b: Box) => JSON.stringify(a) === JSON.stringify(b)
const fmt = (b: Box) => (b ? `${b.x},${b.y} ${b.w}×${b.h}` : "none")

/** What moved or flashed on the way from `before` (the first frame) to the settled last frame. */
function problems(frames: ReadonlyArray<Frame>, added: ReadonlyArray<string>) {
  const first = frames[0]!
  const last = frames.at(-1)!
  const out: Array<string> = []
  for (const f of frames) {
    // Never moved; sized as before or as after (the panel's Show picker is as wide as its choice).
    for (const key of ["tabs", "search", "sort"] as const)
      if (
        f[key]?.x !== first[key]?.x ||
        f[key]?.y !== first[key]?.y ||
        !(same(f[key], first[key]) || same(f[key], last[key]))
      )
        out.push(`${f.t}ms ${key} ${fmt(first[key])} → ${fmt(f[key])}`)
    if (!same(f.tile, first.tile) && !same(f.tile, last.tile))
      out.push(`${f.t}ms tile ${fmt(f.tile)} (before ${fmt(first.tile)}, after ${fmt(last.tile)})`)
    if (f.scrollWidth !== first.scrollWidth) out.push(`${f.t}ms scroll width ${first.scrollWidth} → ${f.scrollWidth}`)
    if (f.pageWidth !== first.pageWidth) out.push(`${f.t}ms page width ${first.pageWidth} → ${f.pageWidth}`)
    if (f.loading.length) out.push(`${f.t}ms loading ${f.loading.join(" | ")}`)
  }
  for (const a of added) out.push(`inserted ${a}`)
  return out
}

const TABS = ["All", "With chats", "Never used", "Favourites", "Personas", "Groups", "Archived"]
// Every ordered pair exactly once, as one walk from All (an Euler circuit of the tabs, Hierholzer's):
// A→B is followed by B→…, so each switch starts from a settled tab.
const walk = () => {
  const left = new Map(TABS.map((a) => [a, TABS.filter((b) => b !== a)]))
  const stack = ["All"]
  const steps: Array<string> = []
  while (stack.length) {
    const at = stack.at(-1)!
    const next = left.get(at)!.shift()
    if (next === undefined) steps.push(stack.pop()!)
    else stack.push(next)
  }
  return steps.reverse()
}

/** Waits for nothing to change for 20 frames, at most 3 s. */
const settle = (page: Page) =>
  page.waitForFunction(
    () => {
      const frames = window.__tabFrames!.frames
      if (frames.length < 25) return false
      const tail = frames.slice(-20).map((f) => JSON.stringify({ ...f, t: 0 }))
      return tail.every((f) => f === tail[0]) || (frames.at(-1)?.t ?? 0) > 3000
    },
    undefined,
    { polling: "raf", timeout: 10_000 }
  )

const runWalk = async (
  page: Page,
  scope: string,
  choose: (tab: string) => Promise<void>
): Promise<Array<{ step: string; frames: number; problems: ReadonlyArray<string> }>> => {
  const results = []
  const steps = walk()
  for (let i = 1; i < steps.length; i++) {
    const [from, to] = [steps[i - 1]!, steps[i]!]
    await startRecording(page, scope)
    // A frame of the settled tab first, so the first frame is the one before the click.
    await page.waitForFunction(() => window.__tabFrames!.frames.length >= 2, undefined, { polling: "raf" })
    await choose(to)
    await settle(page)
    const { frames, added } = await stopRecording(page)
    results.push({ step: `${from} → ${to}`, frames: frames.length, problems: problems(frames, added) })
  }
  return results
}

const report = (place: string, results: Awaited<ReturnType<typeof runWalk>>) => {
  for (const r of results)
    console.log(
      `[${place}] ${r.step}: ${r.frames} frames, ${r.problems.length ? r.problems.slice(0, 6).join("; ") : "still"}`
    )
  return results.filter((r) => r.problems.length).map((r) => `${r.step}: ${r.problems[0]}`)
}

test("home: switching between any two tabs moves nothing and shows no loading frame", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  const main = page.getByRole("main")
  const show = main.getByRole("group", { name: "Show", exact: true })
  await expect(show.getByRole("button", { name: "Groups", exact: true })).toHaveText(/^Groups\s*50$/)
  await expect(show.getByRole("button", { name: "Personas", exact: true })).toHaveText(/^Personas\s*53$/)
  const results = await runWalk(page, "main", (tab) => show.getByRole("button", { name: tab, exact: true }).click())
  expect(report("home", results)).toEqual([])
})

test("left panel: switching between any two tabs moves nothing and shows no loading frame", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  const panel = page.getByRole("complementary").first()
  await panel.getByRole("group", { name: "Left panel", exact: true }).getByText("Characters").click()
  const picker = panel.getByRole("combobox", { name: "Show" })
  await expect(picker).toBeVisible()
  await panel.evaluate((el) => el.setAttribute("data-tab-switch-scope", ""))
  const results = await runWalk(page, "[data-tab-switch-scope]", async (tab) => {
    await picker.click()
    await page.getByRole("option", { name: new RegExp(`^${tab} · `) }).click()
  })
  expect(report("panel", results)).toEqual([])
})

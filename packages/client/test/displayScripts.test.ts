import { expect, it, vi } from "vitest"
import type { EntityId } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { DEFAULT_DISPLAY_PREFS } from "@rp/shared/chatApi.ts"
import type { RegexScript } from "@rp/shared/docs/regexScript.ts"
import { runDisplayRegex } from "../src/features/chat/displayRegex.ts"
import {
  approvedScripts,
  builtinDisplayScriptLists,
  type CardDisplay,
  CardScripts,
  type DisplayScriptList,
  displayScripts,
  messageCharacter
} from "../src/features/chat/displayScripts.ts"
import { makeRegistry } from "../src/registry.ts"
import { regexDisplay } from "../src/features/chat/displayWorker.ts"

const script = (id: string, find: string, replace: string, fields: Partial<RegexScript> = {}): RegexScript => ({
  id,
  name: id,
  find_regex: find,
  replace_string: replace,
  trim_strings: [],
  placement: [1, 2],
  disabled: false,
  markdown_only: true,
  prompt_only: false,
  run_on_edit: false,
  substitute_regex: "none",
  min_depth: null,
  max_depth: null,
  ...fields
})
const run = (scripts: ReadonlyArray<RegexScript>, text: string, placement = 2) =>
  runDisplayRegex({ text, scripts, placement, depth: 0, names: { user: "Ana", char: "Mira" }, card: {} }).text

const mira = "mira" as EntityId
const ana = "ana" as EntityId
const kai = "kai" as EntityId

it("the display viewer switch is on by default, and off keeps the text without running anything", () => {
  expect(DEFAULT_DISPLAY_PREFS.displayRegex).toBe(true)
  const Worker = vi.fn()
  vi.stubGlobal("Worker", Worker)
  try {
    const off = regexDisplay({
      text: "a",
      version: {} as never,
      names: { user: "Ana", char: "Mira" },
      card: {},
      prefs: { ...DEFAULT_DISPLAY_PREFS, displayRegex: false },
      scripts: [script("g", "/a/", "b")],
      placement: 2,
      depth: 0
    })
    expect(off).toEqual({ text: "a", issues: [] })
    expect(Worker).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

it("a preset's or card's scripts count only once approved", () => {
  const scripts = [script("p", "/a/", "b")]
  expect(approvedScripts(null)).toEqual([])
  expect(approvedScripts({ regex: scripts })).toEqual([])
  expect(approvedScripts({ regex: scripts, regex_approved: false })).toEqual([])
  expect(approvedScripts({ regex_approved: true })).toEqual([])
  expect(approvedScripts({ regex: scripts, regex_approved: true })).toEqual(scripts)
})

const lists = (
  global: ReadonlyArray<RegexScript>,
  preset: ReadonlyArray<RegexScript>,
  character: ReadonlyArray<RegexScript>,
  registered: ReadonlyArray<DisplayScriptList> = builtinDisplayScriptLists
) => displayScripts(registered, { global, preset, character, characterId: null, placement: 2 })

it("scripts run global, then preset, then character", () => {
  const global = [script("g", "/a/", "b")]
  const preset = [script("p", "/b/", "c")]
  const character = [script("c", "/c/", "d")]
  const ordered = lists(global, preset, character)
  expect(ordered.map((s) => s.id)).toEqual(["g", "p", "c"])
  // Each sees the one before it: a → b → c → d. Another order stops early.
  expect(run(ordered, "a")).toBe("d")
  expect(run(lists(character, preset, global), "a")).toBe("b")
  expect(lists([], [], [])).toBe(lists([], [], []))
  // Only display-only scripts for the placement, whichever list holds them.
  expect(run(lists([script("g", "/a/", "b", { markdown_only: false })], preset, []), "a")).toBe("a")
  expect(run(lists(global, [script("p", "/b/", "c", { placement: [1] })], []), "a")).toBe("b")
})

it("the lists are registered parts: one can be replaced, disabled or added, by order", () => {
  const global = [script("g", "/a/", "b")]
  const preset = [script("p", "/b/", "c")]
  const registry = makeRegistry<DisplayScriptList>()
  const undo = builtinDisplayScriptLists.map((list) => registry.register(list))
  const off = registry.disable("display-regex.preset")
  expect(lists(global, preset, [], registry.list()).map((s) => s.id)).toEqual(["g"])
  off()
  registry.register({ id: "plugin.first", order: 0, scripts: () => [script("x", "/z/", "a")] })
  expect(lists(global, preset, [], registry.list()).map((s) => s.id)).toEqual(["x", "g", "p"])
  registry.register({ id: "display-regex.global", order: 10, scripts: () => [] })
  expect(lists(global, preset, [], registry.list()).map((s) => s.id)).toEqual(["x", "p"])
  for (const done of undo) done()
})

it("a model-side message takes its speaker's scripts; a user-side one the only other character's", () => {
  const solo = { participants: [ana, mira], playedByMe: [ana] }
  expect(messageCharacter(solo, mira, 2)).toBe(mira)
  expect(messageCharacter(solo, ana, 1)).toBe(mira)
  expect(messageCharacter(solo, null, 2)).toBe(mira)
  const group = { participants: [ana, mira, kai], playedByMe: [ana] }
  expect(messageCharacter(group, kai, 2)).toBe(kai)
  expect(messageCharacter(group, ana, 1)).toBe(null)
  expect(messageCharacter(group, null, 2)).toBe(null)
  expect(messageCharacter({ participants: [ana], playedByMe: [ana] }, ana, 1)).toBe(null)
  expect(messageCharacter(null, null, 1)).toBe(null)
})

it("card scripts are read once per member, refreshed without dropping them, and change listeners only on change", async () => {
  let answer: CardDisplay | null = { scripts: [script("c", "/a/", "b")], panels: null }
  const read = vi.fn(async (_: EntityId) => answer)
  const cards = new CardScripts(read)
  const listener = vi.fn()
  cards.subscribe(listener)
  expect(cards.get(null)).toEqual([])
  expect(cards.get(mira)).toEqual([])
  expect(cards.get(mira)).toEqual([])
  expect(read).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
  const first = cards.get(mira)
  expect(first.map((s) => s.id)).toEqual(["c"])
  cards.refresh()
  expect(cards.get(mira)).toBe(first)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  await Promise.resolve()
  expect(listener).toHaveBeenCalledTimes(1)
  // Approval revoked (or the card gone): the next read has none.
  answer = null
  cards.refresh()
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2))
  expect(cards.get(mira)).toEqual([])
})

it("a member's first read lands even when refreshes keep restarting it", async () => {
  // Each read answers only after the next refresh began (context changes while a chat opens).
  const pending: Array<() => void> = []
  const read = vi.fn(
    (_: EntityId) =>
      new Promise<CardDisplay | null>((resolve) =>
        pending.push(() => resolve({ scripts: [script("c", "/a/", "b")], panels: null }))
      )
  )
  const cards = new CardScripts(read)
  expect(cards.get(mira)).toEqual([])
  cards.refresh()
  pending.shift()!()
  await vi.waitFor(() => expect(cards.get(mira).map((s) => s.id)).toEqual(["c"]))
  // The newer read still answers for it afterwards.
  pending.shift()!()
  await Promise.resolve()
  expect(cards.get(mira).map((s) => s.id)).toEqual(["c"])
})

it("a member's panel permissions are read with its scripts, and a change to them alone tells listeners", async () => {
  const refId = "ref-mira" as RefId
  let answer: CardDisplay | null = { scripts: [], panels: { refId, name: "Mira", scripts: false, network: false } }
  const cards = new CardScripts(async () => answer)
  const listener = vi.fn()
  cards.subscribe(listener)
  expect(cards.panels(mira)).toBe(null)
  await vi.waitFor(() => expect(cards.panels(mira)).toEqual({ refId, name: "Mira", scripts: false, network: false }))
  answer = { scripts: [], panels: { refId, name: "Mira", scripts: true, network: false } }
  cards.refresh()
  await vi.waitFor(() => expect(cards.panels(mira)?.scripts).toBe(true))
  expect(listener).toHaveBeenCalledTimes(2)
  expect(cards.panels(null)).toBe(null)
})

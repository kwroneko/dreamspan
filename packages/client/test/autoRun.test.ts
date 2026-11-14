import type { EntityId, SlotId, VersionId } from "@rp/shared/chat.ts"
import { describe, expect, it } from "vitest"
import {
  type AutoRun,
  canResume,
  counted,
  counting,
  makeRunStore,
  newRun,
  parseBounds,
  resumed,
  type Seen,
  started,
  starting,
  stepOf,
  stopped,
  stopText,
  type Tip
} from "../src/features/autoRun/run.ts"

const tip = (slot: string, version = `${slot}-v1`): Tip => ({ slotId: slot as SlotId, versionId: version as VersionId })
const seen = (leaf: Tip | null, status = "complete", over: Partial<Seen> = {}): Seen => ({
  forkId: "f1",
  atLeaf: true,
  leaf: leaf === null ? null : { ...leaf, status },
  hasText: false,
  queued: 0,
  replier: "mira" as EntityId,
  picked: false,
  candidates: 3,
  ready: true,
  busy: false,
  approval: false,
  ...over
})
const run = (turns = 3, tokenLimit: number | null = null): AutoRun => newRun("f1", turns, tokenLimit, tip("s1"))
/** A run whose reply at `slot` is being written. */
const writing = (from: AutoRun, slot: string) => started(starting(from), tip(slot), `token-${slot}`)

describe("auto replies: what a run does next", () => {
  it("starts a reply only from the message it left, complete, with nothing typed, queued or picked", () => {
    expect(stepOf(run(), seen(tip("s1")))).toEqual({ do: "start" })
    expect(stepOf(run(), seen(tip("s1"), "complete", { hasText: true }))).toEqual({ do: "stop", why: "typed" })
    expect(stepOf(run(), seen(tip("s1"), "complete", { queued: 1 }))).toEqual({ do: "stop", why: "queued" })
    expect(stepOf(run(), seen(tip("s1"), "complete", { picked: true }))).toEqual({ do: "stop", why: "picked" })
    expect(stepOf(run(), seen(tip("s1"), "complete", { candidates: 1 }))).toEqual({ do: "stop", why: "nobody" })
    expect(stepOf(run(), seen(tip("s1"), "complete", { replier: null }))).toEqual({ do: "stop", why: "nobody" })
    expect(stepOf(run(), seen(tip("s1"), "complete", { forkId: "f2" }))).toEqual({ do: "stop", why: "branch" })
    // Someone else's message, a swipe of the last one, or a reply being written by another tab.
    expect(stepOf(run(), seen(tip("s2")))).toEqual({ do: "stop", why: "moved" })
    expect(stepOf(run(), seen(tip("s1", "s1-v2")))).toEqual({ do: "stop", why: "moved" })
    expect(stepOf(run(), seen(tip("s1"), "generating"))).toEqual({ do: "stop", why: "moved" })
    expect(stepOf(run(), seen(null))).toEqual({ do: "stop", why: "moved" })
  })

  it("a manual pick ends a run even while its request is pending", () => {
    expect(stepOf(starting(run()), seen(tip("s1"), "complete", { picked: true }))).toEqual({
      do: "stop",
      why: "picked"
    })
  })

  it("an approval ends a run while it is pending, before a render can miss the waiting step", () => {
    expect(stepOf(starting(run()), seen(tip("s1"), "complete", { approval: true }))).toEqual({
      do: "stop",
      why: "approval"
    })
  })

  it("waits, sending nothing, while the chat is loading or a request of its own is out", () => {
    expect(stepOf(run(), seen(tip("s1"), "complete", { ready: false }))).toEqual({ do: "wait" })
    expect(stepOf(run(), seen(tip("s1"), "complete", { busy: true }))).toEqual({ do: "wait" })
    expect(stepOf(run(), seen(tip("s9"), "complete", { atLeaf: false }))).toEqual({ do: "wait" })
    expect(stepOf(starting(run()), seen(tip("s1")))).toEqual({ do: "wait" })
    expect(stepOf(counting(writing(run(), "s2")), seen(tip("s2")))).toEqual({ do: "wait" })
    // Typing still ends it while it waits.
    expect(stepOf(starting(run()), seen(tip("s1"), "complete", { hasText: true }))).toEqual({
      do: "stop",
      why: "typed"
    })
  })

  it("follows its own reply: waits while it's written, counts it when complete, ends on anything else", () => {
    const now = writing(run(), "s2")
    expect(stepOf(now, seen(tip("s2"), "generating"))).toEqual({ do: "wait" })
    expect(stepOf(now, seen(tip("s2"), "generating", { approval: true }))).toEqual({ do: "stop", why: "approval" })
    expect(stepOf(now, seen(tip("s2"), "complete"))).toEqual({ do: "count", versionId: "s2-v1" })
    expect(stepOf(now, { ...seen(tip("s2")), leaf: { ...tip("s2"), status: "complete", empty: true } })).toEqual({
      do: "stop",
      why: "failed"
    })
    expect(stepOf(now, seen(tip("s2"), "failed"))).toEqual({ do: "stop", why: "failed" })
    expect(stepOf(now, seen(tip("s2"), "interrupted"))).toEqual({ do: "stop", why: "failed" })
    expect(stepOf(now, seen(tip("s2"), "stopped"))).toEqual({ do: "stop", why: "stopped" })
    // Swiped while it was written, or something posted after it.
    expect(stepOf(now, seen(tip("s2", "s2-v2"), "generating"))).toEqual({ do: "stop", why: "moved" })
    expect(stepOf(now, seen(tip("s3")))).toEqual({ do: "stop", why: "moved" })
  })

  it("ends at its bounds: the number of replies, then the tokens written", () => {
    let now = run(2, 500)
    now = counted(writing(now, "s2"), { tokens: 200, requests: 1 })
    expect(now).toMatchObject({ done: 1, tokens: 200, requests: 1, tip: tip("s2"), waiting: null, pending: null })
    expect(stepOf(now, seen(tip("s2")))).toEqual({ do: "start" })
    const full = counted(writing(now, "s3"), { tokens: 100, requests: 3 })
    expect(full).toMatchObject({ done: 2, tokens: 300, requests: 4 })
    expect(stepOf(full, seen(tip("s3")))).toEqual({ do: "stop", why: "done" })
    const spent = counted(writing(run(5, 250), "s2"), { tokens: 260, requests: 1 })
    expect(stepOf(spent, seen(tip("s2")))).toEqual({ do: "stop", why: "tokens" })
  })

  it("a stopped run does nothing more, keeps its first reason, and carries on only when resumed", () => {
    const ended = stopped(stopped(writing(run(), "s2"), "typed"), "moved")
    expect(ended.stop).toBe("typed")
    expect(stepOf(ended, seen(tip("s2")))).toEqual({ do: "wait" })
    // A reply posted after the stop isn't taken up.
    expect(started(ended, tip("s3"), "t").waiting).toEqual(tip("s3"))
    expect(canResume(ended)).toBe(false)
    expect(canResume(counted(ended, { tokens: 5, requests: 1 }))).toBe(true)
    const again = resumed(ended, tip("s2"))
    expect(again).toMatchObject({ stop: null, done: 0, turns: 3, waiting: null, tip: tip("s2") })
    expect(again.id).not.toBe(ended.id)
    expect(stepOf(again, seen(tip("s2")))).toEqual({ do: "start" })
    const done = stopped(counted(writing(run(1), "s2"), { tokens: 5, requests: 1 }), "done")
    expect(canResume(done)).toBe(false)
    expect(canResume(stopped(counted(writing(run(5, 10), "s2"), { tokens: 50, requests: 1 }), "tokens"))).toBe(false)
  })

  it("a lost acknowledgement never replenishes the stated reply allowance", () => {
    const pending = starting(run(1, 10))
    expect(pending.asked).toBe(1)
    const lost = stopped(pending, "error", "Connection lost")
    expect(canResume(lost)).toBe(false)
    expect(stepOf(lost, seen(tip("s1")))).toEqual({ do: "wait" })
  })

  it("says why it ended, briefly", () => {
    const one = counted(writing(run(4), "s2"), { tokens: 5, requests: 1 })
    expect(stopText(stopped(one, "typed"))).toBe("Stopped after 1 of 4: you started typing.")
    expect(stopText(stopped(one, "approval"))).toBe("Stopped after 1 of 4: a tool is waiting for your approval.")
    expect(stopText(stopped(one, "error", "No model is chosen."))).toBe("Stopped after 1 of 4: No model is chosen.")
    expect(stopText(stopped(one, "done"))).toBe("Done: 1 reply.")
    expect(stopText(one)).toBe("")
  })

  it("reads the dialog's bounds strictly", () => {
    expect(parseBounds("5", "")).toEqual({ turns: 5, tokenLimit: null })
    expect(parseBounds(" 12 ", "4000")).toEqual({ turns: 12, tokenLimit: 4000 })
    for (const bad of ["", "0", "51", "2.5", "-1", "many"]) expect(parseBounds(bad, "").turns).toBeNull()
    for (const bad of ["0", "1.5", "lots"]) expect(parseBounds("5", bad).tokenLimit).toBeUndefined()
  })

  it("a late answer for a run that was replaced changes nothing", () => {
    const store = makeRunStore()
    const first = run()
    store.set(first)
    const second = resumed(stopped(first, "you"), tip("s1"))
    store.set(second)
    expect(store.update(first.id, (r) => started(r, tip("s2"), "t"))).toBeNull()
    expect(store.get()).toBe(second)
    store.set(null)
    expect(store.update(second.id, starting)).toBeNull()
  })

  it("carries the server's token from each reply to the next, and drops it on Continue", () => {
    const first = run()
    expect(first.token).toBeNull()
    const second = writing(first, "s2")
    expect(second.token).toBe("token-s2")
    // Continue is the user's own click: the server starts a run again.
    expect(resumed(stopped(counted(second, { tokens: 1, requests: 1 }), "moved"), tip("s2")).token).toBeNull()
  })

  it("says in plain words why the server ended it", () => {
    expect(stopText(stopped(run(), "settings"))).toContain("a setting, preset, model or library entry changed")
    expect(stopText(stopped(run(), "restarted"))).toContain("the server restarted")
  })
})

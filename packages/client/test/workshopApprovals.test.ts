// The workshop's approvals and undo in the client (spec/WORKSHOP.md §3.4, §3.6), apart from React:
// where a change opens, what's still undoable, which replies warn before a new version, how the
// warning settles, and that a waiting call keeps the steps in sight.
import { describe, expect, it, vi } from "vitest"
import type { RolloutStep } from "@dreamspan/shared/agent.ts"
import type { VersionId } from "@dreamspan/shared/chat.ts"
import type { RolloutEffect } from "@dreamspan/shared/workshopApi.ts"
import { waitsForUser } from "../src/features/chat/agent/stepActions.ts"
import { statusText } from "../src/features/chat/agent/steps.ts"
import { guardReply, replyGuards, type ReplyGuardRequest } from "../src/features/chat/replyGuards.ts"
import { chatKindLooks } from "../src/features/chat/kindLooks.ts"
import {
  binnedTargets,
  groupByReply,
  opensNow,
  openTarget,
  outstanding,
  undoAllOffered,
  undoable,
  undoHint
} from "../src/features/workshop/effects.ts"
import { workshopLook } from "../src/features/workshop/kinds.ts"
import {
  askBeforeReply,
  keptCalls,
  mayWarn,
  subagentLine,
  warningEffects,
  warningGroups,
  warningText
} from "../src/features/workshop/regenerateWarning.ts"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})

const effect = (over: Partial<RolloutEffect>): RolloutEffect => ({
  rolloutId: "r1",
  toolCallId: "c1",
  seq: 0,
  kind: "library.revise",
  targetKind: "entity",
  targetId: "e1",
  title: "Edited the card Mara Quill",
  undo: { refId: "ref1" },
  undoResult: null,
  undoneAt: null,
  createdAt: 1,
  ...over
})

const request = (over: Partial<ReplyGuardRequest> = {}): ReplyGuardRequest => ({
  chatId: "chat1",
  kind: "workshop",
  versionId: "v1" as VersionId,
  hasSteps: true,
  action: "regenerate",
  ...over
})

const tool = (status: Extract<RolloutStep, { kind: "tool" }>["status"]): RolloutStep => ({
  kind: "tool",
  id: "c1",
  tool: "edit_card",
  label: "Edited a card",
  title: "Mara Quill",
  args: {},
  status,
  effect: "external",
  effectClass: "library"
})

describe("a workshop change", () => {
  it("opens the item it made or edited, by its library entry when known, or the chat it started", () => {
    expect(openTarget(effect({}))).toEqual({ to: "/library/$refId", params: { refId: "ref1" } })
    expect(openTarget(effect({ undo: null }))).toEqual({ to: "/cards/$entityId", params: { entityId: "e1" } })
    expect(openTarget(effect({ kind: "chat.create", targetKind: "chat", targetId: "chat2" }))).toEqual({
      to: "/chats/$chatId",
      params: { chatId: "chat2" }
    })
    expect(openTarget(effect({ targetKind: "setting" }))).toBeNull()
  })

  it("can be undone while it stands and the app kept how; a new version leaves the standing ones", () => {
    const undone = effect({ seq: 1, undoneAt: 5 })
    const fixed = effect({ seq: 2, undo: null })
    expect([effect({}), undone, fixed].map(undoable)).toEqual([true, false, false])
    expect(outstanding([effect({}), undone, fixed]).map((e) => e.seq)).toEqual([0, 2])
    expect(undoHint(effect({ kind: "library.create" }))).toMatch(/bin/)
    expect(undoHint(effect({}))).toMatch(/keeping edits made since/)
  })

  it("offers Open only while the item is out of the bin", () => {
    const binned = effect({ kind: "library.delete" })
    expect(undoHint(binned)).toBe("Takes it back out of the bin.")
    // Put in the bin: nothing to open until that is undone.
    expect([binned, effect({ kind: "library.delete", undoneAt: 5 })].map(opensNow)).toEqual([false, true])
    // Made: there to open until its undo bins it. An edit's undo leaves the item where it is.
    const made = effect({ kind: "library.create" })
    expect([made, effect({ kind: "library.create", undoneAt: 5 })].map(opensNow)).toEqual([true, false])
    expect([effect({}), effect({ undoneAt: 5 })].map(opensNow)).toEqual([true, true])
  })

  it("knows which items a later change of the assistant's left in the bin", () => {
    const made = effect({ kind: "library.create", targetId: "note1" })
    const binned = effect({ kind: "library.delete", targetId: "note1", seq: 1 })
    expect([...binnedTargets([made, binned])]).toEqual(["note1"])
    // Taken back out: it opens again.
    expect([...binnedTargets([made, { ...binned, undoneAt: 5 }])]).toEqual([])
  })
})

describe("the Changes tab's replies", () => {
  it("groups changes by the reply that made them, newest reply first, and merges a later page in", () => {
    const first = [
      effect({ rolloutId: "r2", toolCallId: "b", createdAt: 30 }),
      effect({ rolloutId: "r2", toolCallId: "a", createdAt: 20 }),
      effect({ rolloutId: "r1", toolCallId: "z", createdAt: 10 })
    ]
    // "Show older" read the rest of r1, and an older reply.
    const older = [
      effect({ rolloutId: "r1", toolCallId: "y", createdAt: 5 }),
      effect({ rolloutId: "r0", createdAt: 1 })
    ]
    const groups = groupByReply([...first, ...older])
    expect(groups.map((g) => g.rolloutId)).toEqual(["r2", "r1", "r0"])
    expect(groups[1]!.effects.map((e) => e.toolCallId)).toEqual(["z", "y"])
    expect(groups.map((g) => g.startedAt)).toEqual([20, 5, 1])
  })

  it("offers Undo all while any change of the reply can still be undone", () => {
    const [group] = groupByReply([effect({ undoneAt: 2 }), effect({ toolCallId: "c2" })])
    expect(undoAllOffered(group!)).toBe(true)
    const [done] = groupByReply([effect({ undoneAt: 2 }), effect({ toolCallId: "c2", undo: null })])
    expect(undoAllOffered(done!)).toBe(false)
  })
})

describe("the regenerate warning", () => {
  it("keeps a subagent's changes with the agent call that started it, and names them by its handle", () => {
    const child = (handle: string, callId: string, toolCallId: string) =>
      effect({ rolloutId: `child-${handle}`, toolCallId, subagent: { handle, rolloutId: "r1", callId } })
    const kept = child("research-1", "c1", "child-a")
    const later = child("research-2", "c9", "child-b")
    const own = effect({ toolCallId: "c8" })
    const steps = { ok: true as const, value: [tool("done")] }
    // c1 (the kept `agent` call) keeps its subagent's change; the later call's are listed.
    expect(
      warningEffects(
        request({ action: "resume-step", fromStep: { index: 1, keepsCall: false } }),
        { ok: true, value: [kept, later, own] },
        steps
      )
    ).toEqual({
      ok: true,
      value: [later, own]
    })
    expect(warningGroups([later, own, child("research-10", "c10", "child-c")]).map((g) => g.handle)).toEqual([
      null,
      "research-2",
      "research-10"
    ])
    expect(subagentLine("research-2", 3)).toBe("This reply's subagent research-2 made 3 changes:")
    expect(subagentLine("research-2", 1)).toBe("This reply's subagent research-2 made 1 change:")
    // Changes groups it under the reply whose call started it.
    expect(groupByReply([kept, own]).map((g) => [g.rolloutId, g.effects.length])).toEqual([["r1", 2]])
  })
  it("blocks regeneration when effects or retained steps cannot be read", () => {
    const failure = {
      ok: false as const,
      error: { tag: "ServerError", message: "Unavailable", problems: [], reason: null },
      cause: null
    }
    const effects = { ok: true as const, value: [effect({})] }
    const steps = { ok: true as const, value: [tool("done")] }
    expect(warningEffects(request(), failure, steps)).toBe(failure)
    expect(warningEffects(request(), effects, failure)).toEqual(effects)
    expect(warningEffects(request(), effects, steps)).toEqual(effects)
    expect(
      warningEffects(request({ action: "resume-step", fromStep: { index: 0, keepsCall: false } }), effects, failure)
    ).toBe(failure)
  })
  it("is only for a reply that made tool calls, in a kind with changes", () => {
    const close = chatKindLooks.register(workshopLook)
    try {
      expect(mayWarn(request())).toBe(true)
      expect(mayWarn(request({ hasSteps: false }))).toBe(false)
      expect(mayWarn(request({ kind: "rp" }))).toBe(false)
      // Carrying on from a step, where the kind isn't known: the host reads its changes to decide.
      expect(mayWarn(request({ kind: undefined, action: "resume-step" }))).toBe(true)
    } finally {
      close()
    }
  })

  it("lets a story reply through at once, and a second ask cancels the first", async () => {
    const close = chatKindLooks.register(workshopLook)
    try {
      expect(await askBeforeReply(request({ kind: "rp" }))).toBe(true)
      const first = askBeforeReply(request())
      const second = askBeforeReply(request({ versionId: "v2" as VersionId }))
      expect(await first).toBe(false)
      // Nothing answers the second here; it stays open until the dialog settles it.
      void second
    } finally {
      close()
    }
  })

  it("keeps calls only when resuming from a step", () => {
    const steps: ReadonlyArray<RolloutStep> = [
      { ...tool("done"), id: "a" } as RolloutStep,
      { kind: "thinking", text: "x" },
      { ...tool("done"), id: "b" } as RolloutStep
    ]
    expect([...keptCalls(steps, request())]).toEqual([])
    const from = (index: number, keepsCall: boolean) =>
      request({ action: "resume-step", fromStep: { index, keepsCall } })
    expect([...keptCalls(steps, from(2, false))]).toEqual(["a"])
    expect([...keptCalls(steps, from(2, true))]).toEqual(["a", "b"])
    expect([...keptCalls(steps, from(0, false))]).toEqual([])
    // The words say what the merged rules do: nothing is undone; the reply's own steps are kept.
    expect(warningText("regenerate")).toMatch(/again from the start/)
    expect(warningText("resume-step")).toMatch(/keeps the steps before it/)
  })

  it("holds back a new version when any guard refuses, in order", async () => {
    const seen: Array<string> = []
    const closeA = replyGuards.register({ id: "a", check: async () => (seen.push("a"), false) })
    const closeB = replyGuards.register({ id: "b", check: async () => (seen.push("b"), true) })
    try {
      expect(await guardReply(request())).toBe(false)
      expect(seen).toEqual(["a"])
    } finally {
      closeB()
      closeA()
    }
    expect(await guardReply(request())).toBe(true)
  })
})

describe("a call waiting for the user", () => {
  it("keeps the steps in sight, and its row says so", () => {
    expect(waitsForUser([tool("done"), tool("waiting")])).toBe(true)
    expect(waitsForUser([tool("running"), { kind: "text", text: "x" }])).toBe(false)
    expect(waitsForUser(null)).toBe(false)
    expect(statusText.waiting).toBe("Waiting for you")
  })
})
